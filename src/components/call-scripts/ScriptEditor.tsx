import { useState } from 'react';
import { Save, Rocket, EyeOff, Loader2, Info } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import {
  LIMITS,
  scenarioLabel,
  validateScriptDraft,
  type CallScript,
  type CallScriptVersion,
  type ScenarioKey,
} from '@/lib/callScripts';

export interface ScriptDraftState {
  opening_line: string;
  body: string;
  note: string;
}

export type EditorBusy = null | 'save' | 'publish' | 'unpublish';

interface ScriptEditorProps {
  scenario: ScenarioKey;
  script: CallScript | null;
  versions: CallScriptVersion[];
  draft: ScriptDraftState;
  onDraftChange: (next: ScriptDraftState) => void;
  dirty: boolean;
  busy: EditorBusy;
  onSave: (publish: boolean) => void;
  onUnpublish: () => void;
}

export function ScriptEditor({
  scenario,
  script,
  versions,
  draft,
  onDraftChange,
  dirty,
  busy,
  onSave,
  onUnpublish,
}: ScriptEditorProps) {
  const [touched, setTouched] = useState({ opening_line: false, body: false });
  const check = validateScriptDraft({ scenario, opening_line: draft.opening_line, body: draft.body });
  const liveVersion = versions.find((v) => v.id === script?.active_version_id) ?? null;
  const hasVersions = versions.length > 0;
  const canSave = check.ok && (dirty || !hasVersions) && busy === null;

  const bodyLength = draft.body.trim().length;
  const openingLength = draft.opening_line.trim().length;

  return (
    <div className="space-y-5">
      <div
        className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${
          liveVersion ? 'border-success-500/30 bg-success-500/10' : 'border-border bg-bg-tertiary'
        }`}
      >
        <Info size={16} className={`mt-0.5 shrink-0 ${liveVersion ? 'text-success-500' : 'text-text-secondary'}`} />
        <p className="text-text-primary">
          {liveVersion ? (
            <>
              <span className="font-semibold">Version {liveVersion.version_number} is live</span> for{' '}
              {scenarioLabel(scenario).toLowerCase()} calls
              {script?.challenger_version_id ? ' and an A/B test is running.' : '.'}
            </>
          ) : (
            <>
              <span className="font-semibold">Not live yet.</span> Save a version, then publish it to start using it on real
              calls. Until then your assistant uses its base prompt for this scenario.
            </>
          )}
        </p>
      </div>

      <Input
        label="Opening line"
        value={draft.opening_line}
        maxLength={LIMITS.openingMax + 50}
        onChange={(e) => onDraftChange({ ...draft, opening_line: e.target.value })}
        onBlur={() => setTouched((t) => ({ ...t, opening_line: true }))}
        error={touched.opening_line ? check.errors.opening_line : undefined}
        helperText={`${openingLength}/${LIMITS.openingMax} — what the assistant says first in this scenario. Optional.`}
        placeholder="Thanks for calling — how can I help?"
      />

      <Textarea
        label="Script guidance"
        required
        rows={12}
        value={draft.body}
        onChange={(e) => onDraftChange({ ...draft, body: e.target.value })}
        onBlur={() => setTouched((t) => ({ ...t, body: true }))}
        error={touched.body ? check.errors.body : undefined}
        helperText={`${bodyLength}/${LIMITS.bodyMax} — what to ask, in what order, what never to promise. Written as guidance; the assistant keeps its own natural voice.`}
      />

      <Input
        label="What changed? (optional)"
        value={draft.note}
        maxLength={LIMITS.noteMax}
        onChange={(e) => onDraftChange({ ...draft, note: e.target.value })}
        helperText="Shown in version history so you remember why you changed it."
        placeholder="Ask for the unit age before quoting"
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-text-secondary" aria-live="polite">
          {dirty && hasVersions ? 'You have unsaved changes.' : hasVersions ? 'Everything is saved.' : 'Nothing saved yet.'}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          {liveVersion && (
            <Button type="button" variant="ghost" size="sm" onClick={onUnpublish} disabled={busy !== null}>
              {busy === 'unpublish' ? <Loader2 size={15} className="animate-spin" /> : <EyeOff size={15} />}
              Unpublish
            </Button>
          )}
          <Button type="button" variant="secondary" size="sm" onClick={() => onSave(false)} disabled={!canSave}>
            {busy === 'save' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            Save version
          </Button>
          <Button type="button" size="sm" onClick={() => onSave(true)} disabled={!canSave}>
            {busy === 'publish' ? <Loader2 size={15} className="animate-spin" /> : <Rocket size={15} />}
            Save &amp; publish
          </Button>
        </div>
      </div>
    </div>
  );
}
