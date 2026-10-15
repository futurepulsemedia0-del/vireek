import { AlertCircle, Loader2, RotateCw } from 'lucide-react';
import { formatDuration, type JobMessage, type SenderRole } from '@/lib/jobMessages';

export type DeliveryState = 'sent' | 'sending' | 'failed';

interface Props {
  message: JobMessage;
  viewer: SenderRole;
  mediaUrl?: string;
  delivery: DeliveryState;
  onOpenPhoto: (url: string) => void;
  onRetry: (clientId: string) => void;
}

function time(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function MessageBubble({ message, viewer, mediaUrl, delivery, onOpenPhoto, onRetry }: Props) {
  const mine = message.sender_role === viewer;
  const senderLabel = message.sender_role === 'office' ? 'Office' : 'Technician';

  return (
    <div className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
      {!mine && <span className="mb-0.5 px-1 text-xs font-medium text-text-secondary">{senderLabel}</span>}
      <div
        className={`max-w-[85%] overflow-hidden rounded-2xl text-sm ${
          mine ? 'rounded-br-md bg-accent text-white' : 'rounded-bl-md border border-border bg-bg-secondary text-text-primary'
        } ${delivery === 'sending' ? 'opacity-70' : ''}`}
      >
        {message.kind === 'text' && (
          <p dir="auto" className="whitespace-pre-wrap break-words px-3.5 py-2.5">{message.body}</p>
        )}

        {message.kind === 'photo' &&
          (mediaUrl ? (
            <button type="button" onClick={() => onOpenPhoto(mediaUrl)} className="focus-ring block" aria-label="Open photo full screen">
              <img src={mediaUrl} alt="Job photo" loading="lazy" className="max-h-72 w-full object-cover" />
            </button>
          ) : (
            <div className="flex h-40 w-56 items-center justify-center bg-bg-tertiary text-xs text-text-secondary">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> Loading photo…
            </div>
          ))}

        {message.kind === 'audio' && (
          <div className="px-3 py-2.5">
            {mediaUrl ? (
              <audio controls preload="metadata" src={mediaUrl} className="h-10 w-56 max-w-full" aria-label="Voice note" />
            ) : (
              <span className="text-xs opacity-80">Loading voice note…</span>
            )}
            <span className="mt-1 block text-xs opacity-75">{formatDuration(message.media_duration_ms)}</span>
          </div>
        )}
      </div>

      <div className="mt-0.5 flex items-center gap-1.5 px-1 text-[11px] text-text-secondary">
        {delivery === 'sending' && <><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Sending…</>}
        {delivery === 'failed' && message.client_id && (
          <button
            type="button"
            onClick={() => onRetry(message.client_id as string)}
            className="focus-ring inline-flex items-center gap-1 rounded text-danger"
          >
            <AlertCircle className="h-3 w-3" aria-hidden="true" /> Not sent · Retry <RotateCw className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
        {delivery === 'sent' && <time dateTime={message.created_at}>{time(message.created_at)}</time>}
      </div>
    </div>
  );
}
