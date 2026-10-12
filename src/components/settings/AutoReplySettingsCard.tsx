import { useEffect, useMemo, useState } from 'react';
import { Bot } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  DEFAULT_AUTO_REPLY_SETTINGS,
  fetchAutoReplySettings,
  parseKeywordInput,
  saveAutoReplySettings,
  type AutoReplySettings,
} from '@/lib/autoReply';

const inputCls =
  'focus-ring mt-2 w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/50';

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-bg-tertiary'}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
    </button>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border/60 py-4">
      <div>
        <p className="text-sm font-medium text-text-primary">{title}</p>
        {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function timezones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    if (list?.length) return list;
  } catch {
    /* older browsers */
  }
  return ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'UTC'];
}

/** Dashboard card: AI auto-reply for inbound SMS + email. Self-contained (loads and saves its own row). */
export function AutoReplySettingsCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [s, setS] = useState<AutoReplySettings>(DEFAULT_AUTO_REPLY_SETTINGS);
  const [keywordText, setKeywordText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const zones = useMemo(timezones, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetchAutoReplySettings(user.id).then((loadedSettings) => {
      if (cancelled) return;
      setS(loadedSettings);
      setKeywordText(loadedSettings.escalationKeywords.join('\n'));
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const patch = (p: Partial<AutoReplySettings>) => {
    setS((prev) => ({ ...prev, ...p }));
    setDirty(true);
  };

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    const result = await saveAutoReplySettings(user.id, { ...s, escalationKeywords: parseKeywordInput(keywordText) });
    if (result.ok) {
      toast('AI auto-reply settings saved.', 'success');
      setDirty(false);
    } else {
      toast('Could not save AI auto-reply settings. Please try again.', 'error');
    }
    setSaving(false);
  };

  const anyOn = s.smsEnabled || s.emailEnabled;

  return (
    <div className="mt-4 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Bot size={16} />
        </span>
        <div>
          <h2 className="text-base font-semibold text-text-primary">AI auto-reply for SMS &amp; email</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Answers inbound texts and emails using your knowledge base, hours and booking rules. Replies are always identified as automated,
            never invent prices, and hand risky messages to your team. Every decision is logged.
          </p>
        </div>
      </div>

      <div className="mt-5">
        <Row title="Reply to inbound SMS">
          <Switch checked={s.smsEnabled} onChange={(v) => patch({ smsEnabled: v })} label="Reply to inbound SMS" />
        </Row>
        <Row title="Reply to inbound email">
          <Switch checked={s.emailEnabled} onChange={(v) => patch({ emailEnabled: v })} label="Reply to inbound email" />
        </Row>
      </div>

      {anyOn && loaded && (
        <div className="space-y-5 border-t border-border/60 pt-5">
          <div>
            <p className="text-sm font-medium text-text-primary">Who sends the reply?</p>
            <div className="mt-2 inline-flex w-full items-center gap-1 rounded-full border border-border bg-bg-primary p-1">
              {([
                ['approval', 'Human approval'],
                ['auto', 'Fully automatic'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => patch({ mode: value })}
                  className={`flex-1 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
                    s.mode === value ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-text-secondary">
              {s.mode === 'approval'
                ? 'The AI drafts; you approve each reply from the Inbox. Recommended while you build trust.'
                : 'Confident, well-grounded replies are sent instantly. Anything below your threshold waits for your approval.'}
            </p>
          </div>

          <div>
            <label htmlFor="ar-threshold" className="text-sm font-medium text-text-primary">
              Confidence threshold: {Math.round(s.confidenceThreshold * 100)}%
            </label>
            <input
              id="ar-threshold"
              type="range"
              min={50}
              max={99}
              value={Math.round(s.confidenceThreshold * 100)}
              onChange={(e) => patch({ confidenceThreshold: Number(e.target.value) / 100 })}
              className="mt-2 w-full accent-[var(--color-accent,#6366f1)]"
            />
            <p className="mt-1 text-xs text-text-secondary">Replies scoring below this are never auto-sent. Higher = safer, more drafts for you.</p>
          </div>

          <div>
            <label htmlFor="ar-keywords" className="text-sm font-medium text-text-primary">Your escalation keywords</label>
            <p className="mt-0.5 text-xs text-text-secondary">
              One per line. A match skips the AI and flags the conversation for a human (e.g. mold, asbestos, insurance).
            </p>
            <textarea id="ar-keywords" rows={3} value={keywordText} onChange={(e) => { setKeywordText(e.target.value); setDirty(true); }} className={inputCls} />
            <Row title="Also use built-in safety keywords" hint="Gas, fire, flooding, injury, legal threats, refunds, complaints, “speak to a human”…">
              <Switch checked={s.useDefaultKeywords} onChange={(v) => patch({ useDefaultKeywords: v })} label="Use built-in keywords" />
            </Row>
          </div>

          <Row title="Only reply outside business hours" hint="Uses your business hours and holidays in the time zone below.">
            <Switch checked={s.scope === 'after_hours_only'} onChange={(v) => patch({ scope: v ? 'after_hours_only' : 'always' })} label="After hours only" />
          </Row>

          <div>
            <label htmlFor="ar-tz" className="text-sm font-medium text-text-primary">Business time zone</label>
            <select id="ar-tz" value={s.timezone} onChange={(e) => patch({ timezone: e.target.value })} className={inputCls}>
              {(zones.includes(s.timezone) ? zones : [s.timezone, ...zones]).map((z) => (
                <option key={z} value={z}>{z}</option>
              ))}
            </select>
          </div>

          <Row title="Share your online booking link" hint="Only when Online Booking is enabled. The AI never books or promises times itself.">
            <Switch checked={s.shareBookingLink} onChange={(v) => patch({ shareBookingLink: v })} label="Share booking link" />
          </Row>

          <Row title="Send a holding message on escalation" hint="Fully-automatic mode only. A fixed message you control, sent at most once every 6 hours.">
            <Switch checked={s.sendEscalationAck} onChange={(v) => patch({ sendEscalationAck: v })} label="Send holding message" />
          </Row>
          {s.sendEscalationAck && (
            <textarea
              rows={2}
              maxLength={320}
              value={s.escalationAckMessage}
              onChange={(e) => patch({ escalationAckMessage: e.target.value })}
              placeholder="Default: a team member will follow up shortly; if it's an emergency, call your local emergency number."
              className={inputCls}
            />
          )}

          <div>
            <label htmlFor="ar-sig" className="text-sm font-medium text-text-primary">Signature (automated-assistant disclosure)</label>
            <input id="ar-sig" maxLength={80} value={s.signature} onChange={(e) => patch({ signature: e.target.value })} placeholder="— Your Company automated assistant" className={inputCls} />
            <p className="mt-1 text-xs text-text-secondary">Added to emails and the first text in each thread. Replies are always disclosed as automated.</p>
          </div>

          <div>
            <label htmlFor="ar-extra" className="text-sm font-medium text-text-primary">Extra guidance (tone, wording)</label>
            <textarea id="ar-extra" rows={3} maxLength={1000} value={s.extraInstructions} onChange={(e) => patch({ extraInstructions: e.target.value })} placeholder="e.g. Friendly and brief. Always mention we are family-owned." className={inputCls} />
            <p className="mt-1 text-xs text-text-secondary">Style only — it can never override the safety rules.</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="ar-cap" className="text-sm font-medium text-text-primary">Max AI replies / thread / day</label>
              <input id="ar-cap" type="number" min={1} max={20} value={s.maxAutoRepliesPerDay} onChange={(e) => patch({ maxAutoRepliesPerDay: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })} className={inputCls} />
            </div>
            <div>
              <label htmlFor="ar-takeover" className="text-sm font-medium text-text-primary">Pause after you reply (minutes)</label>
              <input id="ar-takeover" type="number" min={0} max={1440} value={s.humanTakeoverMinutes} onChange={(e) => patch({ humanTakeoverMinutes: Math.min(1440, Math.max(0, Number(e.target.value) || 0)) })} className={inputCls} />
            </div>
          </div>
        </div>
      )}

      <div className="mt-5 flex justify-end border-t border-border/60 pt-4">
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saving || !loaded}
          className="focus-ring rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
