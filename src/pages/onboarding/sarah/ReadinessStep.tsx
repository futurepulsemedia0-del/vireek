import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, PhoneCall, PhoneOff, Play, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { MiniLoader } from '@/components/ui/MiniLoader';
import { supabase } from '@/lib/supabase';
import { getVapiClient, VAPI_DEMO_ASSISTANT_ID } from '@/lib/vapi';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError, confirmTestCall, goLive, runReadiness, track, type ReadinessResponse, type ScenarioResultDto } from './sarahLearnApi';
import { formatDuration, goLiveBlockers, type LearnField, type LearnRun } from './sarahLearnLogic';

interface Props {
  run: LearnRun;
  fields: LearnField[];
  initialResults: ScenarioResultDto[];
  locale: 'en' | 'es';
  businessName: string;
  onReload: () => Promise<void>;
  onLive: (info: { ms: number }) => void;
}

type CallState = 'idle' | 'connecting' | 'active' | 'ended' | 'error';
const SAMPLE_CATEGORIES = ['emergency', 'pricing', 'tone'];

export function ReadinessStep({ run, fields, initialResults, locale, businessName, onReload, onLive }: Props) {
  const { t } = useTranslation('sarahLearn');
  const { refreshProfile } = useAuth();
  const [results, setResults] = useState<ScenarioResultDto[]>(initialResults);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [callState, setCallState] = useState<CallState>('idle');
  const [callEnded, setCallEnded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [going, setGoing] = useState(false);
  const bound = useRef(false);

  const passed = results.filter((r) => r.passed).length;
  const criticalFailed = results.filter((r) => r.critical && !r.passed).map((r) => r.id);
  const blockers = goLiveBlockers(run, fields);
  const samples = useMemo(() => {
    const picked: ScenarioResultDto[] = [];
    for (const c of SAMPLE_CATEGORIES) {
      const hit = results.find((r) => r.category === c && r.reply && !picked.includes(r));
      if (hit) picked.push(hit);
    }
    for (const r of results) if (picked.length < 3 && r.reply && !picked.includes(r)) picked.push(r);
    return picked.slice(0, 3);
  }, [results]);

  useEffect(() => {
    if (initialResults.length) setResults(initialResults);
  }, [initialResults]);

  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel();
      try {
        getVapiClient().stop();
      } catch {
        // not started
      }
    };
  }, []);

  const runAll = async () => {
    setRunning(true);
    setError('');
    try {
      const res: ReadinessResponse = await runReadiness(run.id);
      setResults(res.results);
      track('readiness', { passed: res.scorecard.passed, total: res.scorecard.total, gate: res.scorecard.passed_gate });
      await onReload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('readiness.error'));
    } finally {
      setRunning(false);
    }
  };

  const listen = (r: ScenarioResultDto) => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    if (speaking === r.id) {
      synth.cancel();
      setSpeaking(null);
      return;
    }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(r.reply);
    u.lang = locale === 'es' ? 'es-US' : 'en-US';
    u.onend = () => setSpeaking(null);
    u.onerror = () => setSpeaking(null);
    setSpeaking(r.id);
    synth.speak(u);
  };

  const startCall = async () => {
    setError('');
    setCallState('connecting');
    try {
      const vapi = getVapiClient();
      if (!bound.current) {
        bound.current = true;
        vapi.on('call-start', () => setCallState('active'));
        vapi.on('call-end', () => {
          setCallState('ended');
          setCallEnded(true);
        });
        vapi.on('error', () => setCallState('error'));
      }
      const name = fields.find((f) => f.key === 'business_name')?.value;
      const services = fields.find((f) => f.key === 'services_offered')?.value;
      await vapi.start(VAPI_DEMO_ASSISTANT_ID, {
        variableValues: {
          company_name: typeof name === 'string' ? name : businessName,
          assistant_name: 'Sarah',
          greeting_script: `Thanks for calling ${typeof name === 'string' ? name : businessName}, this is Sarah — how can I help?`,
          services: Array.isArray(services) ? services.join(', ') : '',
        },
      });
    } catch {
      setCallState('error');
    }
  };

  const confirm = async () => {
    setConfirming(true);
    setError('');
    try {
      await confirmTestCall(run.id);
      await onReload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('readiness.error'));
    } finally {
      setConfirming(false);
    }
  };

  const live = async () => {
    setGoing(true);
    setError('');
    try {
      const res = await goLive(run.id);
      await supabase.from('profiles').update({ onboarding_completed: true }).eq('id', (await supabase.auth.getUser()).data.user?.id ?? '');
      await refreshProfile();
      const ms = res.time_to_live_ms ?? Date.now() - new Date(run.started_at).getTime();
      track('go_live', { ms });
      onLive({ ms });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('readiness.goLiveError'));
    } finally {
      setGoing(false);
    }
  };

  const shown = showAll ? results : results.filter((r) => !r.passed);

  return (
    <section aria-labelledby="sl-ready" className="space-y-6">
      <div>
        <h2 id="sl-ready" className="text-xl font-bold text-text-primary">
          {t('readiness.heading')}
        </h2>
        <p className="mt-1 text-sm text-text-secondary">{t('readiness.intro')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={runAll} loading={running} loadingLabel={t('readiness.running')}>
          {results.length ? t('readiness.rerun') : t('readiness.run')}
        </Button>
        {running && (
          <span role="status" className="flex items-center gap-2 text-sm text-text-secondary">
            <MiniLoader /> {t('readiness.running')}
          </span>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {results.length > 0 && (
        <div className="space-y-4" data-testid="scorecard">
          <Card interactive={false} className="!p-4">
            <p className="text-lg font-semibold text-text-primary">{t('readiness.score', { passed, total: results.length })}</p>
            <p className={`text-sm ${run.readiness_passed ? 'text-success-500' : 'text-danger'}`}>{run.readiness_passed ? t('readiness.gateOk') : t('readiness.gateFail')}</p>
            <p className="mt-1 text-xs text-text-secondary">{t('readiness.needed')}</p>
            {criticalFailed.length > 0 && <p className="mt-1 text-xs text-danger">{t('readiness.criticalFailed', { list: criticalFailed.join(', ') })}</p>}
          </Card>

          {samples.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-text-primary">{t('readiness.samples')}</h3>
              {samples.map((r) => (
                <Card key={r.id} interactive={false} className="space-y-1 !p-3 text-sm">
                  <p className="text-text-secondary">
                    <span className="font-medium">{t('readiness.caller')}:</span> {r.caller}
                  </p>
                  <p className="text-text-primary">
                    <span className="font-medium">{t('readiness.sarah')}:</span> {r.reply}
                  </p>
                  {typeof window !== 'undefined' && 'speechSynthesis' in window && (
                    <Button size="xs" variant="secondary" onClick={() => listen(r)} aria-pressed={speaking === r.id}>
                      {speaking === r.id ? <Square size={12} aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}
                      {speaking === r.id ? t('readiness.stopListen') : t('readiness.listen')}
                    </Button>
                  )}
                </Card>
              ))}
            </div>
          )}

          <ul className="space-y-2">
            {shown.map((r) => (
              <li key={r.id} className="rounded-xl border border-border p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2 font-medium text-text-primary">
                  {r.passed ? <Check size={14} className="text-success-500" aria-hidden="true" /> : <X size={14} className="text-danger" aria-hidden="true" />}
                  <span>{r.passed ? t('readiness.pass') : t('readiness.fail')}</span>
                  <span className="text-text-secondary">· {t(`readiness.cat.${r.category}`, { defaultValue: r.category })}</span>
                  {r.critical && <span className="text-xs text-danger">{t('readiness.critical')}</span>}
                </p>
                <p className="mt-1 text-text-secondary">{r.caller}</p>
                {r.failures.map((f) => (
                  <p key={f} className="mt-1 text-xs text-danger">
                    {f}
                  </p>
                ))}
              </li>
            ))}
          </ul>
          <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? t('readiness.hide') : t('readiness.show')}
          </Button>
        </div>
      )}

      <Card interactive={false} className="space-y-3 !p-4">
        <h3 className="text-base font-semibold text-text-primary">{t('readiness.testTitle')}</h3>
        <p className="text-sm text-text-secondary">{t('readiness.testBody')}</p>
        {!run.readiness_passed && <p className="text-xs text-text-secondary">{t('readiness.testNeedsReadiness')}</p>}
        <div className="flex flex-wrap items-center gap-3">
          {callState === 'active' || callState === 'connecting' ? (
            <Button variant="danger" onClick={() => getVapiClient().stop()}>
              <PhoneOff size={16} aria-hidden="true" /> {t('readiness.testEnd')}
            </Button>
          ) : (
            <Button variant="secondary" disabled={!run.readiness_passed || !!run.test_call_confirmed_at} onClick={startCall}>
              <PhoneCall size={16} aria-hidden="true" /> {t('readiness.testStart')}
            </Button>
          )}
          <span role="status" className="text-sm text-text-secondary">
            {callState === 'connecting' ? t('readiness.testConnecting') : callState === 'active' ? t('readiness.testActive') : callState === 'error' ? t('readiness.testError') : ''}
          </span>
        </div>
        {run.test_call_confirmed_at ? (
          <p className="flex items-center gap-1.5 text-sm text-success-500">
            <Check size={14} aria-hidden="true" /> {t('readiness.testConfirmed')}
          </p>
        ) : (
          <Button size="sm" disabled={!callEnded || !run.readiness_passed} loading={confirming} onClick={confirm}>
            {t('readiness.testConfirm')}
          </Button>
        )}
      </Card>

      {blockers.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-text-secondary">
          {blockers.map((b) => (
            <li key={b}>{t(`readiness.blockers.${b}`)}</li>
          ))}
        </ul>
      )}

      <Button size="lg" disabled={blockers.length > 0} disabledReason={blockers[0] ? t(`readiness.blockers.${blockers[0]}`) : undefined} loading={going} loadingLabel={t('readiness.goLiving')} onClick={live}>
        {t('readiness.goLive')}
      </Button>
    </section>
  );
}

export { formatDuration };
