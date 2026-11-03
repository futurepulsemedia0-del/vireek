import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { Select } from '@/components/ui/Select';
import { Input, Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  BETA_NOTE, DEFAULT_GREETINGS, INTERP_META, MODE_LABELS, NON_ENGLISH, interpLabel, loadInterpreterSettings, saveInterpreterSettings,
  type InterpMode, type InterpreterSettings, type NonEnglish,
} from '@/lib/interpreter';

const E164 = /^\+[1-9][0-9]{7,14}$/;

export function InterpreterSettingsCard() {
  const { toast } = useToast();
  const [s, setS] = useState<InterpreterSettings | null>(null);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(false);
    loadInterpreterSettings().then((v) => alive && setS(v)).catch(() => alive && setError(true));
    return () => { alive = false; };
  }, [attempt]);

  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-border p-4 text-sm">
        Couldn’t load interpreter settings, or you don’t have permission to manage live calls.
        <Button size="xs" variant="secondary" className="ml-3" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
      </div>
    );
  }
  if (!s) return <div aria-busy="true" className="space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-40 w-full" /></div>;

  const numberInvalid = Boolean(s.bridge_number) && !E164.test(s.bridge_number as string);
  const bridgeMode = s.default_mode.startsWith('bridge');
  const patch = (p: Partial<InterpreterSettings>) => setS({ ...s, ...p });
  const toggleLang = (l: NonEnglish) => patch({ enabled_languages: s.enabled_languages.includes(l) ? s.enabled_languages.filter((x) => x !== l) : [...s.enabled_languages, l] });

  const save = async () => {
    if (numberInvalid) return;
    if (s.enabled && s.enabled_languages.length === 0) { toast('Choose at least one language.', 'error'); return; }
    setSaving(true);
    try {
      const greetings = Object.fromEntries(Object.entries(s.greetings).filter(([, v]) => typeof v === 'string' && v.trim()));
      await saveInterpreterSettings({ ...s, greetings, bridge_number: s.bridge_number?.trim() || null });
      toast('Interpreter settings saved.', 'success');
    } catch {
      toast('Couldn’t save. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <Switch checked={s.enabled} onChange={(v) => patch({ enabled: v })} label="Live interpretation" hint="Serve callers in their own language and translate for your team." />

      <fieldset className="space-y-2" disabled={!s.enabled}>
        <legend className="text-sm font-semibold text-text-primary">Languages</legend>
        <p className="text-xs text-text-secondary">{BETA_NOTE}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {NON_ENGLISH.map((l) => (
            <label key={l} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <input type="checkbox" checked={s.enabled_languages.includes(l)} onChange={() => toggleLang(l)} />
              <span>{interpLabel(l)}</span>
              <span className="ml-auto rounded-full bg-warning-500/10 px-2 py-0.5 text-[10px] font-semibold text-warning-500">Beta</span>
            </label>
          ))}
        </div>
      </fieldset>

      <Select label="How calls are handled" value={s.default_mode} onChange={(e) => patch({ default_mode: e.target.value as InterpMode })} disabled={!s.enabled}>
        {(Object.keys(MODE_LABELS) as InterpMode[]).map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
      </Select>

      {bridgeMode && (
        <Input
          label="Interpreter bridge phone number"
          value={s.bridge_number ?? ''}
          onChange={(e) => patch({ bridge_number: e.target.value })}
          placeholder="+15551234567"
          error={numberInvalid ? 'Use international format, e.g. +15551234567' : undefined}
          helperText="A Twilio number pointed at the interpreter-bridge-twiml function."
        />
      )}

      <div className="space-y-3">
        <p className="text-sm font-semibold text-text-primary">Greeting per language</p>
        <p className="text-xs text-text-secondary">Leave empty to use the default. Use {'{business}'} and {'{assistant}'}.</p>
        {s.enabled_languages.map((l) => (
          <Textarea
            key={l} label={INTERP_META[l].name} lang={l} dir={INTERP_META[l].dir} rows={2} maxLength={400}
            value={s.greetings[l] ?? ''} placeholder={DEFAULT_GREETINGS[l]}
            onChange={(e) => patch({ greetings: { ...s.greetings, [l]: e.target.value } })}
          />
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Keep translated transcripts (days)" type="number" min={7} max={730} value={String(s.retention_days)}
          onChange={(e) => patch({ retention_days: Math.min(730, Math.max(7, Number(e.target.value) || 90)) })}
          helperText="7–730. Older interpreted transcripts are deleted automatically." />
        <Input label="State for recording-consent rules" value={s.recording_state ?? ''} maxLength={2}
          onChange={(e) => patch({ recording_state: e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || null })}
          helperText="Two-letter state code, e.g. CA." />
      </div>

      <Switch checked={s.training_opt_in} onChange={(v) => patch({ training_opt_in: v })} label="Allow improving models with my calls"
        hint="Off by default. Even when on, a call is only used if the caller consented on that call." />

      <Button onClick={save} loading={saving} loadingLabel="Saving…" disabled={numberInvalid} disabledReason={numberInvalid ? 'Fix the phone number first' : undefined}>Save settings</Button>
    </div>
  );
}
