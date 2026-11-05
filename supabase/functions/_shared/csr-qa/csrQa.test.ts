import { describe, it, expect } from 'vitest';
import { MIN_AGENT_SAMPLE, fairnessReport, scoreHumanCall, type AgentReview } from './qa.ts';

const GOOD = `AGENT: Thanks for calling Acme, this is Dana. This call may be recorded.
CALLER: My furnace stopped and I'm really frustrated, how much will it cost?
AGENT: I'm sorry, that sounds stressful. It depends on the diagnosis, so the technician gives you an estimate on site. What is the address?
CALLER: 12 Elm St.
AGENT: Thanks. Is the unit making any noise? I can book a visit tomorrow morning, does that work?`;
const BAD = `AGENT: Yeah.
CALLER: My furnace is out and I'm so upset, how much is it?
AGENT: It will be $400. I guarantee it.`;

describe('human CSR QA rubric', () => {
  it('scores a strong call high with evidence clips and no coaching beyond minor items', () => {
    const r = scoreHumanCall(GOOD, { recordingNoticeRequired: true });
    expect(r.reviewable).toBe(true);
    expect(r.overall).toBeGreaterThanOrEqual(85);
    expect(r.scores.compliance).toBe(100);
    expect(r.clips.length).toBeGreaterThan(3);
    expect(r.clips.every((c) => c.startTurn <= c.endTurn)).toBe(true);
  });
  it('flags a weak call: no greeting, bare price, guarantee, no empathy, no recording notice', () => {
    const r = scoreHumanCall(BAD, { recordingNoticeRequired: true });
    expect(r.overall).toBeLessThan(55);
    expect(r.coaching).toEqual(expect.arrayContaining(['greet_with_name', 'acknowledge_feelings', 'state_recording_notice', 'avoid_guarantees', 'ask_for_the_booking']));
  });
  it('not-applicable dimensions are excluded, not scored as zero', () => {
    const r = scoreHumanCall('AGENT: Thanks for calling Acme, this is Dana. How can I help? \nCALLER: I want to book a visit.\nAGENT: Sure, I can schedule you tomorrow. What is the address?', { recordingNoticeRequired: false });
    expect(r.scores.price_handling).toBeNull();
    expect(r.scores.empathy).toBeNull();
    expect(r.overall).not.toBeNull();
  });
  it('does not score one-sided or empty transcripts', () => {
    expect(scoreHumanCall(null, { recordingNoticeRequired: false }).reviewable).toBe(false);
    expect(scoreHumanCall('AGENT: hello there', { recordingNoticeRequired: false }).overall).toBeNull();
  });
  it('is deterministic', () => {
    expect(scoreHumanCall(GOOD, { recordingNoticeRequired: true })).toEqual(scoreHumanCall(GOOD, { recordingNoticeRequired: true }));
  });
});

describe('fairness and per-agent reporting', () => {
  const rev = (agentId: string, overall: number, scenario: string, language: string | null = null, i = 0): AgentReview =>
    ({ agentId, at: new Date(Date.UTC(2026, 9, 1 + (i % 25))).toISOString(), overall, scenario, afterHours: false, language });
  const NOW = Date.UTC(2026, 10, 3);

  it('hides per-agent numbers below the minimum sample', () => {
    const f = fairnessReport(Array.from({ length: MIN_AGENT_SAMPLE - 1 }, (_, i) => rev('a', 80, 'new_inquiry', null, i)), NOW);
    expect(f.agents[0].suppressed).toBe(true);
    expect(f.agents[0].rawMean).toBeNull();
  });

  it('adjusts for call mix: an agent who only takes hard calls is not ranked last by raw score alone', () => {
    const rs: AgentReview[] = [];
    // hard scenario: everyone scores ~60; easy scenario: everyone scores ~90. Agent H takes only hard calls, E only easy, M mixes.
    for (let i = 0; i < 10; i++) rs.push(rev('H', 62, 'complaint', null, i), rev('E', 88, 'new_inquiry', null, i));
    for (let i = 0; i < 5; i++) rs.push(rev('M', 60, 'complaint', null, i), rev('M', 90, 'new_inquiry', null, i));
    const f = fairnessReport(rs, NOW);
    const H = f.agents.find((a) => a.agentId === 'H')!;
    const M = f.agents.find((a) => a.agentId === 'M')!;
    expect((H.rawMean as number)).toBeLessThan(M.rawMean as number - 5);           // raw: H looks much worse
    expect(Math.abs((H.adjustedMean as number) - (M.adjustedMean as number))).toBeLessThan(5); // adjusted: about the same
  });

  it('flags large language-group score gaps as a possible rubric bias', () => {
    const rs: AgentReview[] = [];
    for (let i = 0; i < 25; i++) rs.push(rev('a', 85, 'new_inquiry', 'en', i), rev('b', 70, 'new_inquiry', 'es', i));
    const f = fairnessReport(rs, NOW);
    expect(f.languageGapFlags).toHaveLength(1);
    expect(f.languageGapFlags[0].gap).toBeGreaterThanOrEqual(8);
  });
  it('does not flag gaps on thin data', () => {
    const rs: AgentReview[] = [];
    for (let i = 0; i < 5; i++) rs.push(rev('a', 85, 'x', 'en', i), rev('b', 50, 'x', 'es', i));
    expect(fairnessReport(rs, NOW).languageGapFlags).toEqual([]);
  });
});
