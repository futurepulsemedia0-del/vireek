import { useState } from 'react';
import { Star, CheckCircle2 } from 'lucide-react';
import { submitCallFeedback } from '@/lib/callFeedback';

export function CallSatisfactionWidget({ callId, userId }: { callId: string; userId: string }) {
  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [comment, setComment] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  if (submitted) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-bg-primary p-4 text-sm text-text-secondary">
        <CheckCircle2 size={16} className="text-success" />
        Thanks — your feedback on this AI interaction was recorded.
      </div>
    );
  }

  const handleSubmit = async () => {
    if (!rating) return;
    setSaving(true);
    const result = await submitCallFeedback(callId, userId, rating, comment);
    setSaving(false);
    if (result.ok) setSubmitted(true);
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-bg-primary p-4">
      <p className="text-xs font-medium text-text-secondary">How did the AI handle this call?</p>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setRating(n)}
            onMouseEnter={() => setHovered(n)}
            onMouseLeave={() => setHovered(0)}
            className="focus-ring rounded p-0.5"
            aria-label={`Rate ${n} of 5`}
          >
            <Star
              size={20}
              className={(hovered || rating) >= n ? 'fill-accent text-accent' : 'text-text-secondary/40'}
            />
          </button>
        ))}
      </div>
      {rating > 0 && (
        <>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Optional: what happened? (helps train the assistant)"
            rows={2}
            className="focus-ring w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60"
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving}
            className="focus-ring rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Submit feedback'}
          </button>
        </>
      )}
    </div>
  );
}
