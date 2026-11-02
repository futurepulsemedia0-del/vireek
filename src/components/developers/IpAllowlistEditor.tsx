import { useState } from 'react';
import { parseAllowlistInput } from '../../../supabase/functions/api-v1/contract';

/** Inline editor for a key's IP allowlist. Validation is the same code the API enforces with. */
export function IpAllowlistEditor({
  initial,
  saving,
  onSave,
  onCancel,
}: {
  initial: string[];
  saving: boolean;
  onSave: (list: string[]) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial.join('\n'));
  const parsed = parseAllowlistInput(text);
  const errorId = 'ip-allowlist-error';
  return (
    <div className="mt-3 rounded-xl border border-border bg-bg-primary p-3">
      <label className="block text-xs font-medium text-text-secondary" htmlFor="ip-allowlist-input">
        Allowed IP addresses or CIDR ranges (one per line, up to 20). Leave empty to allow any
        address.
      </label>
      <textarea
        id="ip-allowlist-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        spellCheck={false}
        aria-invalid={!parsed.ok}
        aria-describedby={parsed.ok ? undefined : errorId}
        placeholder={'203.0.113.7\n198.51.100.0/24'}
        className="focus-ring mt-1.5 w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 font-mono text-xs text-text-primary"
      />
      {!parsed.ok && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-danger">
          {parsed.error}
        </p>
      )}
      {parsed.ok && parsed.list.length > 0 && (
        <p className="mt-1 text-xs text-text-secondary">
          Requests from any other address are rejected with{' '}
          <code className="font-mono">ip_not_allowed</code>. Include the address your integration
          calls from, or it will be locked out.
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={!parsed.ok || saving}
          onClick={() => parsed.ok && onSave(parsed.list)}
          className="focus-ring rounded-lg bg-cta px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save allowlist'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
