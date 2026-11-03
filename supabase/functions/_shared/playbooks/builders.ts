// supabase/functions/_shared/playbooks/builders.ts — tiny typed constructors used by the catalog files.
import type {
  AdvisoryParams, AnyPlaybookItem, CapacityParams, EscalationParams, ScriptScenario, SurgeParams, TemplateParams,
} from './types.ts';

export const script = (id: string, title: string, why: string, scenario: ScriptScenario, opening_line: string, body: string): AnyPlaybookItem =>
  ({ id, kind: 'call_script', title, why, params: { scenario, opening_line, body } });

export const surge = (id: string, title: string, why: string, params: SurgeParams): AnyPlaybookItem =>
  ({ id, kind: 'surge', title, why, params });

export const escalate = (id: string, title: string, why: string, params: EscalationParams): AnyPlaybookItem =>
  ({ id, kind: 'escalation_rule', title, why, params });

export const capacity = (id: string, title: string, why: string, params: CapacityParams): AnyPlaybookItem =>
  ({ id, kind: 'capacity', title, why, params });

export const template = (id: string, title: string, why: string, params: TemplateParams): AnyPlaybookItem =>
  ({ id, kind: 'message_template', title, why, params });

export const closure = (id: string, title: string, why: string, label: string, message: string, defaultEnabled = true): AnyPlaybookItem =>
  ({ id, kind: 'closure', title, why, params: { label, message }, defaultEnabled });

export const automation = (id: string, title: string, why: string, slug: string): AnyPlaybookItem =>
  ({ id, kind: 'automation', title, why, params: { slug } });

export const advisory = (id: string, title: string, why: string, params: AdvisoryParams): AnyPlaybookItem =>
  ({ id, kind: 'advisory', title, why, params });
