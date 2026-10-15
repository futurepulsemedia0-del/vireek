import { useRef, useState } from 'react';
import { Camera, Mic, Send, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useVoiceRecorder, type RecordedClip } from '@/hooks/useVoiceRecorder';
import { MAX_TEXT_LENGTH, MAX_VOICE_SECONDS, formatDuration } from '@/lib/jobMessages';

interface Props {
  disabled?: boolean;
  onSendText: (body: string) => void;
  onSendPhoto: (file: File) => void;
  onSendAudio: (clip: RecordedClip) => void;
}

export function MessageComposer({ disabled, onSendText, onSendPhoto, onSendAudio }: Props) {
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const recorder = useVoiceRecorder(onSendAudio);
  const recording = recorder.state === 'recording';

  function submit() {
    const body = text.trim();
    if (!body || disabled) return;
    onSendText(body);
    setText('');
  }

  return (
    <div className="border-t border-border bg-bg-primary px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {recorder.state === 'denied' && (
        <p role="alert" className="mb-2 text-xs text-danger">Microphone access is blocked. Allow it in your browser settings to send voice notes.</p>
      )}

      {recording ? (
        <div className="flex items-center gap-3" role="status" aria-live="polite">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
          </span>
          <span className="flex-1 text-sm font-medium text-text-primary">
            Recording {formatDuration(recorder.elapsed * 1000)} <span className="text-text-secondary">/ {formatDuration(MAX_VOICE_SECONDS * 1000)}</span>
          </span>
          <Button variant="ghost" size="sm" onClick={recorder.cancel} aria-label="Cancel recording"><X className="h-4 w-4" /></Button>
          <Button size="sm" onClick={recorder.stop} aria-label="Stop and send voice note"><Square className="h-4 w-4" /> Send</Button>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onSendPhoto(f);
              e.target.value = '';
            }}
          />
          <Button variant="secondary" size="sm" className="!px-3" disabled={disabled} onClick={() => fileRef.current?.click()} aria-label="Take or attach photo">
            <Camera className="h-5 w-5" />
          </Button>
          <textarea
            dir="auto"
            rows={1}
            value={text}
            maxLength={MAX_TEXT_LENGTH}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
              if (e.key === 'Enter' && !e.shiftKey && !coarse) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Message the office…"
            aria-label="Message"
            className="focus-ring max-h-32 min-h-[40px] flex-1 resize-none rounded-xl border border-border bg-bg-primary px-3.5 py-2 text-base text-text-primary placeholder:text-text-secondary/60 focus-visible:border-accent"
          />
          {text.trim() ? (
            <Button size="sm" className="!px-3" disabled={disabled} onClick={submit} aria-label="Send message"><Send className="h-5 w-5" /></Button>
          ) : (
            <Button
              variant="secondary" size="sm" className="!px-3"
              disabled={disabled || recorder.state === 'unsupported'}
              onClick={recorder.start}
              aria-label={recorder.state === 'unsupported' ? 'Voice notes are not supported on this device' : 'Record voice note'}
            >
              <Mic className="h-5 w-5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
