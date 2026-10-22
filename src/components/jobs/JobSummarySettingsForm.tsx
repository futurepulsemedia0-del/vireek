import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import {
  CHANNEL_LABELS,
  DEFAULT_SETTINGS,
  describeSummaryError,
  renderSms,
  validateSettings,
  type JobSummarySettings,
  type SummaryChannel,
} from '@/lib/jobSummaries';
import { saveSettings } from '@/lib/jobSummariesApi';

const input = 'w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus-ring';
const lbl = 'mb-1 block text-xs font-medium text-text-secondary';

function Toggle({ id, checked, onChange, title, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; title: string; hint?: string }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--color-accent,#2563eb)]" />
      <span>
        <span className="block text-sm font-medium text-text-primary">{title}</span>
        {hint && <span className="block text-xs text-text-secondary">{hint}</span>}
      </span>
    </label>
  );
}

export function JobSummarySettingsForm({ ownerId, initial, onSaved }: { ownerId: string; initial: JobSummarySettings; onSaved: (s: JobSummarySettings) => void }) {
  const { toast } = useToast();
  const [s, setS] = useState<JobSummarySettings>(initial);
  const [saving, setSaving] = useState(false);
  const errors = validateSettings(s);
  const set = <K extends keyof JobSummarySettings>(k: K, v: JobSummarySettings[K]) => setS((p) => ({ ...p, [k]: v }));

  async function save() {
    if (Object.keys(errors).length) return void toast(Object.values(errors)[0] as string, 'error');
    setSaving(true);
    try {
      const saved = await saveSettings(ownerId, s);
      setS(saved);
      onSaved(saved);
      toast('Settings saved.', 'success');
    } catch (e) {
      toast(describeSummaryError(e), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-5">
        <h3 className="text-sm font-semibold text-text-primary">Automation</h3>
        <Toggle id="js-auto" checked={s.auto_generate} onChange={(v) => set('auto_generate', v)} title="Create a summary when a job is completed" hint="Only jobs completed after you switch this on. Drafts appear in the review queue." />
        <Toggle id="js-auto-send" checked={s.auto_generate && s.auto_send} onChange={(v) => set('auto_send', v)} title="Send automatically after a review window" hint="Summaries with warnings (no work notes, failed quality check, open dispute, no contact) always wait for a person." />
        {s.auto_generate && s.auto_send && (
          <div className="max-w-xs">
            <label className={lbl} htmlFor="js-window">Review window (minutes)</label>
            <input id="js-window" type="number" min={0} max={2880} className={input} value={s.review_window_minutes} onChange={(e) => set('review_window_minutes', Number(e.target.value))} />
            {errors.review_window_minutes && <p className="mt-1 text-xs text-danger-500">{errors.review_window_minutes}</p>}
          </div>
        )}
        <div className="max-w-xs">
          <label className={lbl} htmlFor="js-channel-s">Default channel</label>
          <select id="js-channel-s" className={input} value={s.channel} onChange={(e) => set('channel', e.target.value as SummaryChannel)}>
            {(Object.keys(CHANNEL_LABELS) as SummaryChannel[]).map((c) => (
              <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>
            ))}
          </select>
        </div>
        <Toggle id="js-ai" checked={s.ai_polish} onChange={(v) => set('ai_polish', v)} title="Tidy the wording with AI" hint="Rewrites technician notes in plain language. Rejected automatically if it adds numbers, prices, links or promises. You always review before sending." />
      </section>

      <section className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-5">
        <h3 className="text-sm font-semibold text-text-primary">What to include</h3>
        <Toggle id="js-photos" checked={s.include_photos} onChange={(v) => set('include_photos', v)} title="Photos" />
        {s.include_photos && (
          <div className="max-w-[10rem]">
            <label className={lbl} htmlFor="js-maxp">Max photos</label>
            <input id="js-maxp" type="number" min={0} max={12} className={input} value={s.max_photos} onChange={(e) => set('max_photos', Math.min(12, Math.max(0, Number(e.target.value))))} />
          </div>
        )}
        <Toggle id="js-parts" checked={s.include_parts} onChange={(v) => set('include_parts', v)} title="Parts used" />
        <Toggle id="js-warr" checked={s.include_warranty} onChange={(v) => set('include_warranty', v)} title="Warranty" />
        <Toggle id="js-tips" checked={s.include_tips} onChange={(v) => set('include_tips', v)} title="Maintenance tips" />
      </section>

      <section className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-5">
        <h3 className="text-sm font-semibold text-text-primary">Your warranty & service defaults</h3>
        <div className="max-w-xs">
          <label className={lbl} htmlFor="js-labor">Labor warranty (days)</label>
          <input id="js-labor" type="number" min={1} max={3650} placeholder="e.g. 90" className={input} value={s.labor_warranty_days ?? ''} onChange={(e) => set('labor_warranty_days', e.target.value === '' ? null : Number(e.target.value))} />
          {errors.labor_warranty_days && <p className="mt-1 text-xs text-danger-500">{errors.labor_warranty_days}</p>}
        </div>
        <div>
          <label className={lbl} htmlFor="js-pw">Parts warranty note</label>
          <input id="js-pw" className={input} maxLength={300} placeholder="Parts carry the manufacturer’s warranty." value={s.parts_warranty_note ?? ''} onChange={(e) => set('parts_warranty_note', e.target.value || null)} />
        </div>
        <div className="max-w-xs">
          <label className={lbl} htmlFor="js-int">Default service interval (months)</label>
          <input id="js-int" type="number" min={1} max={120} className={input} value={s.default_service_interval_months} onChange={(e) => set('default_service_interval_months', Math.min(120, Math.max(1, Number(e.target.value))))} />
        </div>
        <div>
          <label className={lbl} htmlFor="js-ctips">Your own tips (one per line, up to 6) — shown first</label>
          <textarea id="js-ctips" rows={3} className={input} value={s.custom_tips.join('\n')} onChange={(e) => set('custom_tips', e.target.value.split('\n'))} />
          {errors.custom_tips && <p className="mt-1 text-xs text-danger-500">{errors.custom_tips}</p>}
        </div>
      </section>

      <section className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-5">
        <h3 className="text-sm font-semibold text-text-primary">Messages</h3>
        <div>
          <label className={lbl} htmlFor="js-sms">Text message — variables: {'{{customer_first_name}} {{business_name}} {{service_type}} {{link}}'}</label>
          <textarea id="js-sms" rows={3} className={input} value={s.sms_body} onChange={(e) => set('sms_body', e.target.value)} />
          {errors.sms_body ? (
            <p className="mt-1 text-xs text-danger-500">{errors.sms_body}</p>
          ) : (
            <p className="mt-1 text-xs text-text-secondary">Preview: {renderSms(s.sms_body, { customer_first_name: 'Jane', business_name: 'Your Business', service_type: 'AC Repair', link: 'https://…/summary/…' })}</p>
          )}
        </div>
        <div>
          <label className={lbl} htmlFor="js-subj">Email subject</label>
          <input id="js-subj" className={input} value={s.email_subject} onChange={(e) => set('email_subject', e.target.value)} />
          {errors.email_subject && <p className="mt-1 text-xs text-danger-500">{errors.email_subject}</p>}
        </div>
      </section>

      <div className="flex gap-2">
        <Button onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} Save settings
        </Button>
        <Button variant="ghost" onClick={() => setS(DEFAULT_SETTINGS)}>Reset to defaults</Button>
      </div>
    </div>
  );
}
