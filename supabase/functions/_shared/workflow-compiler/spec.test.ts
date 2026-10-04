import { describe, it, expect } from 'vitest';
import { compileIr, evaluateRule, renderTemplate, maskPii, validateIr } from './spec';

/* eslint-disable @typescript-eslint/no-explicit-any */
const baseIr: any = {
 name:"VIP HVAC emergency dispatch", summary:"s", trigger:{event:"call.emergency"}, sla_minutes:60,
 nodes:[
  {id:"c1",kind:"lookup",label:"Customer",capability:"customer_profile"},
  {id:"d_vip",kind:"decision",label:"VIP?",rule:{path:"c1.is_vip",op:"truthy"}},
  {id:"r1",kind:"reason",label:"Classify",question:"Is this an HVAC emergency? {{trigger.summary}}",options:["hvac_emergency","other"],fields:[{key:"likely_part",type:"string"}]},
  {id:"d_hvac",kind:"decision",label:"HVAC?",rule:{path:"r1.choice",op:"eq",value:"hvac_emergency"}},
  {id:"l_tech",kind:"lookup",label:"Techs",capability:"technician_roster"},
  {id:"l_part",kind:"lookup",label:"Part",capability:"part_availability",params:{query_path:"r1.likely_part"}},
  {id:"ap",kind:"approval",label:"Confirm price",prompt:"Confirm price for {{customer.name}}: {{r1.rationale}}",timeout_minutes:15},
  {id:"d_part",kind:"decision",label:"Part in stock?",rule:{path:"l_part.in_stock",op:"truthy"}},
  {id:"dispatch",kind:"action",label:"Dispatch",capability:"dispatch_technician"},
  {id:"contractor",kind:"action",label:"Contractor",capability:"post_contractor_handoff",params:{trade:"hvac",title:"HVAC emergency {{r1.likely_part}}"}},
  {id:"v",kind:"verify",label:"Assigned?",capability:"job_assigned",params:{target:"dispatch"}},
  {id:"n_std",kind:"action",label:"Notify",capability:"notify_owner",params:{title:"Non-VIP",message:"x"}}
 ],
 edges:[
  {from:"c1",to:"d_vip",on:"next"},{from:"d_vip",to:"r1",on:"true"},{from:"d_vip",to:"n_std",on:"false"},
  {from:"r1",to:"d_hvac",on:"next"},{from:"d_hvac",to:"l_tech",on:"true"},{from:"d_hvac",to:"n_std",on:"false"},
  {from:"l_tech",to:"l_part",on:"next"},{from:"l_part",to:"ap",on:"next"},{from:"ap",to:"d_part",on:"approved"},
  {from:"d_part",to:"dispatch",on:"true"},{from:"d_part",to:"contractor",on:"false"},
  {from:"dispatch",to:"v",on:"next"},{from:"dispatch",to:"contractor",on:"fail"},{from:"v",to:"contractor",on:"fail"}
 ]};

const clone = () => JSON.parse(JSON.stringify(baseIr));

describe('workflow compiler core', () => {
  it('compiles the VIP HVAC emergency workflow and guarantees fallbacks', () => {
    const r: any = compileIr(clone());
    expect(r.ok).toBe(true);
    expect(r.report.approvals).toBe(1);
    expect(r.report.commitment_actions).toBe(2);
    expect(r.report.auto_escalations).toBeGreaterThan(0);
    expect(r.graph.edges.l_tech.fail).toBe('__escalate');
    expect(r.graph.nodes.__escalate.capability).toBe('notify_owner');
  });

  it('refuses a commitment action that is not dominated by an approval', () => {
    const bad = clone();
    bad.nodes = bad.nodes.filter((n: any) => n.id !== 'ap');
    bad.edges = bad.edges.filter((e: any) => e.from !== 'l_part' && e.from !== 'ap');
    bad.edges.push({ from: 'l_part', to: 'd_part', on: 'next' });
    const r: any = compileIr(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('human_approval');
  });

  it('rejects cycles, unknown capabilities and template roots that are not earlier nodes', () => {
    const cyc = clone();
    cyc.edges.push({ from: 'v', to: 'c1', on: 'pass' });
    expect((compileIr(cyc) as any).ok).toBe(false);

    const cap = clone();
    cap.nodes[0].capability = 'drop_tables';
    expect((compileIr(cap) as any).errors.join(' ')).toContain('not a valid lookup');

    const tpl = clone();
    tpl.nodes[2].question = '{{zzz.x}}';
    expect((compileIr(tpl) as any).errors.join(' ')).toContain('zzz');
  });

  it('rejects references to outputs a node does not produce', () => {
    const bad = clone();
    bad.nodes[1].rule.path = 'c1.password';
    expect((compileIr(bad) as any).errors.join(' ')).toContain('no output "password"');
  });

  it('rejects invalid trigger events and non-objects', () => {
    const bad = clone();
    bad.trigger.event = 'drop.database';
    expect(validateIr(bad).ir).toBeNull();
    expect(validateIr(null).ir).toBeNull();
  });

  it('evaluates rules and templates deterministically', () => {
    expect(evaluateRule({ path: 'a.b', op: 'in', value: ['x', 'Y'] }, { a: { b: 'y' } })).toBe(true);
    expect(evaluateRule({ path: 'a.n', op: 'gte', value: 3 }, { a: { n: 2 } })).toBe(false);
    expect(renderTemplate('Hi {{customer.name}} {{a.b}}', { customer: { name: 'Sam' }, a: { b: [1, 2] } })).toBe('Hi Sam 1, 2');
  });

  it('masks phone numbers and emails before AI sees them', () => {
    expect(maskPii('call +1 (555) 123-4567 or a@b.co')).toBe('call [phone] or [email]');
  });
});
