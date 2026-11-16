// src/components/support/FixPanel.tsx
// "Fix" tab: Level 1 (guided steps) + Level 2 (one-click, confirmed, verified actions) + Level 3 activity log.

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ACTIONS, isValidEmail, type ActionId } from '@/lib/supportAgent/actions';
import type { Severity } from '@/lib/supportAgent/diagnostics';
import type { SupportDiagnostics } from './useSupportDiagnostics';

const SEVERITY_ICON: Record<Severity, { Icon: typeof Info; tone: string; label: string }> = {
  critical: { Icon: AlertTriangle, tone: 'text-danger', label: 'Critical' },
  warning: { Icon: AlertTriangle, tone: 'text-warning-500', label: 'Needs attention' },
  info: { Icon: Info, tone: 'text-accent', label: 'Info' },
};

interface Props {
  d: SupportDiagnostics;
  onTalkToTeam: () => void;
}

export function FixPanel({ d, onTalkToTeam }: Props) {
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);

  const needsEmail = d.findings.some((f) => f.actions.some((a) => ACTIONS[a].needsEmail));

  const run = async (action: ActionId) => {
    if (ACTIONS[action].needsEmail && !isValidEmail(email)) {
      setEmailError('Enter a valid email address.');
      return;
    }
    setEmailError('');
    setConfirming(null);
    if (action === 'open_live_chat') onTalkToTeam();
    else await d.execute(action, email.trim());
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm text-text-secondary">
          I check your connection, sign-in session, browser storage and recent errors. Nothing is changed without your OK.
        </p>
        <Button size="sm" variant="primary" loading={d.checking} loadingLabel="Running checks…" onClick={() => void d.runChecks()}>
          {d.findings.length ? 'Run checks again' : 'Run quick check'}
        </Button>
      </div>

      {needsEmail && (
        <Input
          label="Your account email"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          error={emailError}
          onChange={(e) => { setEmail(e.target.value); setEmailError(''); }}
          helperText="Used only to send the email you request. We never reveal whether an account exists."
        />
      )}

      <div aria-live="polite" className="space-y-3">
        {d.findings.map((f) => {
          const { Icon, tone, label } = SEVERITY_ICON[f.severity];
          return (
            <section key={f.id} className="rounded-surface border border-border bg-bg-primary p-3.5" aria-label={f.title}>
              <div className="flex items-start gap-2.5">
                <Icon size={18} className={`mt-0.5 shrink-0 ${tone}`} aria-hidden="true" />
                <div className="min-w-0 space-y-1.5">
                  <h3 className="text-sm font-semibold text-text-primary">
                    {f.title} <span className="sr-only">({label}, {f.confidence} confidence)</span>
                  </h3>
                  <p className="text-xs leading-relaxed text-text-secondary">{f.cause}</p>
                  <ol className="ms-4 list-decimal space-y-1 text-xs text-text-primary">
                    {f.steps.map((s) => <li key={s}>{s}</li>)}
                  </ol>
                </div>
              </div>

              {f.actions.length > 0 && (
                <div className="mt-3 space-y-2 ps-7">
                  {f.actions.map((a) => {
                    const def = ACTIONS[a];
                    const key = `${f.id}:${a}`;
                    const state = d.outcomes[a];
                    const running = state === 'running';
                    return (
                      <div key={key} className="space-y-1.5">
                        {confirming === key ? (
                          <div className="space-y-2 rounded-inset border border-border bg-bg-tertiary p-2.5">
                            <p className="text-xs text-text-primary">{def.confirm}</p>
                            <div className="flex gap-2">
                              <Button size="xs" variant="primary" onClick={() => void run(a)}>Yes, do it</Button>
                              <Button size="xs" variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button>
                            </div>
                          </div>
                        ) : (
                          <Button
                            size="xs"
                            variant={a === f.actions[0] ? 'secondary' : 'ghost'}
                            loading={running}
                            loadingLabel={`${def.label}…`}
                            onClick={() => (def.risk === 'none' && !def.needsEmail ? void run(a) : setConfirming(key))}
                          >
                            {def.label}
                          </Button>
                        )}
                        {state && state !== 'running' && (
                          <p role="status" className={`flex items-start gap-1.5 text-xs ${state.status === 'failed' || state.status === 'blocked' ? 'text-danger' : 'text-success-500'}`}>
                            {state.status === 'verified' || state.status === 'accepted' ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" aria-hidden="true" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />}
                            <span>{state.message}</span>
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {d.findings.length > 0 && d.findings[0].id !== 'healthy' && (
        <p className="text-xs text-text-secondary">
          Still stuck?{' '}
          <button type="button" onClick={onTalkToTeam} className="focus-ring font-semibold text-accent hover:underline">
            Send the report to our team
          </button>
        </p>
      )}

      {d.log.length > 0 && (
        <section aria-label="Self-healing activity" className="space-y-1.5 border-t border-border/70 pt-3">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
            <ShieldCheck size={14} className="text-accent" aria-hidden="true" /> Self-healing activity
          </h3>
          <ul className="space-y-1">
            {d.log.map((l) => (
              <li key={l.id} className={`text-xs ${l.ok ? 'text-text-secondary' : 'text-danger'}`}>
                {new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {l.text}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
