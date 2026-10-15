import { useMemo } from 'react';
import {
  SAMPLE_VALUES,
  analyzeSms,
  buildPreviewSegments,
  renderTemplate,
  type PreviewSegment,
  type TemplateChannel,
} from '@/lib/messageTemplates';

const VARIABLE_STYLES: Record<'value' | 'fallback' | 'unknown' | 'missing', string> = {
  value: 'bg-accent/15 text-accent',
  fallback: 'bg-warning-500/15 text-warning-500',
  unknown: 'bg-danger/15 text-danger',
  missing: 'bg-danger/15 text-danger',
};

const VARIABLE_TITLES: Record<'value' | 'fallback' | 'unknown' | 'missing', string> = {
  value: 'Filled with sample data',
  fallback: 'Fallback text is used when the value is missing',
  unknown: 'Unknown variable',
  missing: 'No value and no fallback',
};

function Segments({ segments }: { segments: PreviewSegment[] }) {
  return (
    <>
      {segments.map((s, i) =>
        s.kind === 'text' ? (
          <span key={i}>{s.text}</span>
        ) : (
          <mark key={i} title={VARIABLE_TITLES[s.state]} className={`rounded px-1 py-0.5 font-medium ${VARIABLE_STYLES[s.state]}`}>
            {s.text}
          </mark>
        ),
      )}
    </>
  );
}

interface TemplatePreviewProps {
  channel: TemplateChannel;
  subject: string;
  body: string;
}

export function TemplatePreview({ channel, subject, body }: TemplatePreviewProps) {
  const bodySegments = useMemo(() => buildPreviewSegments(body, SAMPLE_VALUES), [body]);
  const subjectSegments = useMemo(() => buildPreviewSegments(subject, SAMPLE_VALUES), [subject]);
  const sms = useMemo(() => analyzeSms(renderTemplate(body, SAMPLE_VALUES).text), [body]);
  const isEmpty = body.trim() === '';

  return (
    <section aria-label="Live preview" className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">Live preview</h3>
        {channel === 'sms' && !isEmpty && (
          <p className="text-xs text-text-secondary" aria-live="polite">
            {sms.encoding} · {sms.characters} chars · {sms.segments} segment{sms.segments === 1 ? '' : 's'}
          </p>
        )}
      </div>

      {isEmpty ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-text-secondary">
          Start typing your message to see how it will look.
        </p>
      ) : channel === 'sms' ? (
        <div className="rounded-xl bg-bg-primary p-4">
          <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-bg-tertiary px-4 py-2.5 text-sm leading-relaxed text-text-primary">
            <Segments segments={bodySegments} />
          </div>
          <p className="mt-2 text-[11px] text-text-secondary">Sample data shown. Estimated length can vary with real names.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-bg-primary">
          <div className="border-b border-border px-4 py-3 text-xs text-text-secondary">
            <p>
              <span className="font-medium text-text-primary">From:</span> Summit Home Services
            </p>
            <p className="mt-0.5 break-words">
              <span className="font-medium text-text-primary">Subject:</span>{' '}
              {subject.trim() === '' ? <span className="italic">(no subject)</span> : <Segments segments={subjectSegments} />}
            </p>
          </div>
          <div className="whitespace-pre-wrap break-words px-4 py-4 text-sm leading-relaxed text-text-primary">
            <Segments segments={bodySegments} />
          </div>
        </div>
      )}

      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-secondary" aria-label="Preview legend">
        <li className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-accent" aria-hidden="true" /> Sample value
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-warning-500" aria-hidden="true" /> Fallback used
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-danger" aria-hidden="true" /> Needs attention
        </li>
      </ul>
    </section>
  );
}
