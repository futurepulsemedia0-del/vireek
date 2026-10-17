import { ClipboardEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, Mic, SendHorizontal, Trash2, Square } from 'lucide-react';
import { MAX_TEXT_LENGTH, MAX_VOICE_MS, formatDuration } from '@/lib/teamChat';
import {
  RECORDER_ERROR_COPY,
  isVoiceRecordingSupported,
  useVoiceRecorder,
  type VoiceResult,
} from '@/hooks/useVoiceRecorder';

interface Props {
  channelId: string;
  disabled?: boolean;
  onSendText: (text: string) => string | null;
  onSendImage: (file: File) => Promise<string | null>;
  onSendVoice: (v: VoiceResult) => string | null;
}

const draftKey = (id: string) => `vk-chat-draft-${id}`;
const readDraft = (id: string) => {
  try {
    return localStorage.getItem(draftKey(id)) ?? '';
  } catch {
    return '';
  }
};
const writeDraft = (id: string, value: string) => {
  try {
    if (value) localStorage.setItem(draftKey(id), value);
    else localStorage.removeItem(draftKey(id));
  } catch {
    /* private mode / quota — drafts are a convenience only */
  }
};

export function ChatComposer({ channelId, disabled, onSendText, onSendImage, onSendVoice }: Props) {
  const [text, setText] = useState(() => readDraft(channelId));
  const [notice, setNotice] = useState<string | null>(null);
  const [busyImages, setBusyImages] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const voiceSupported = isVoiceRecordingSupported();

  const handleVoice = useCallback(
    (v: VoiceResult) => {
      const err = onSendVoice(v);
      setNotice(err);
    },
    [onSendVoice],
  );
  const recorder = useVoiceRecorder(handleVoice);

  // Switching conversation swaps the draft.
  useEffect(() => {
    setText(readDraft(channelId));
    setNotice(null);
  }, [channelId]);

  // Auto-grow up to ~6 lines.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [text]);

  const update = (v: string) => {
    setText(v);
    writeDraft(channelId, v);
    if (notice) setNotice(null);
  };

  const submit = () => {
    const err = onSendText(text);
    if (err) {
      setNotice(err);
      return;
    }
    setText('');
    writeDraft(channelId, '');
    areaRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    // Phones: Enter is a newline (use the send button). Desktops: Enter sends.
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    if (coarse) return;
    e.preventDefault();
    submit();
  };

  const sendFiles = async (files: File[]) => {
    if (!files.length) return;
    setBusyImages(true);
    setNotice(null);
    for (const f of files.slice(0, 10)) {
      const err = await onSendImage(f);
      if (err) {
        setNotice(err);
        break;
      }
    }
    setBusyImages(false);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      void sendFiles(files);
    }
  };

  const recording = recorder.state === 'recording';
  const requesting = recorder.starting;
  const hasText = text.trim().length > 0;
  const error = notice ?? (recorder.error ? RECORDER_ERROR_COPY[recorder.error] : null);

  if (recording) {
    return (
      <div className="border-t border-border bg-bg-primary p-3">
        <div className="flex items-center gap-3 rounded-2xl border border-danger/40 bg-danger/5 px-3 py-2" role="status" aria-live="polite">
          <button
            type="button"
            onClick={recorder.cancel}
            aria-label="Cancel voice note"
            className="focus-ring flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary"
          >
            <Trash2 size={20} />
          </button>
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
          </span>
          <span className="flex-1 text-sm font-medium tabular-nums text-text-primary">
            {formatDuration(recorder.elapsedMs)} <span className="text-text-secondary">/ {formatDuration(MAX_VOICE_MS)}</span>
          </span>
          <button
            type="button"
            onClick={recorder.stop}
            aria-label="Send voice note"
            className="focus-ring flex h-11 w-11 items-center justify-center rounded-full bg-accent text-white hover:brightness-110"
          >
            <SendHorizontal size={20} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-border bg-bg-primary p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {error && (
        <p role="alert" className="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          multiple
          className="hidden"
          onChange={(e) => {
            void sendFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || busyImages}
          aria-label="Attach photo"
          className="focus-ring flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
        >
          <ImagePlus size={22} />
        </button>

        <textarea
          ref={areaRef}
          value={text}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          maxLength={MAX_TEXT_LENGTH + 200}
          disabled={disabled}
          enterKeyHint="send"
          placeholder="Message"
          aria-label="Message"
          className="focus-ring max-h-36 min-h-[44px] flex-1 resize-none rounded-2xl border border-border bg-bg-secondary px-4 py-2.5 text-base text-text-primary placeholder:text-text-secondary/60 focus-visible:border-accent disabled:opacity-50"
        />

        {hasText || !voiceSupported ? (
          <button
            type="button"
            onClick={submit}
            disabled={disabled || !hasText}
            aria-label="Send message"
            className="focus-ring flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-accent text-white hover:brightness-110 disabled:opacity-50"
          >
            <SendHorizontal size={20} />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void recorder.start()}
            disabled={disabled || requesting}
            aria-label="Record voice note"
            className="focus-ring flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-accent text-white hover:brightness-110 disabled:opacity-50"
          >
            {requesting ? <Square size={16} /> : <Mic size={20} />}
          </button>
        )}
      </div>
      {text.length > MAX_TEXT_LENGTH - 300 && (
        <p className={`mt-1 text-right text-xs ${text.length > MAX_TEXT_LENGTH ? 'text-danger' : 'text-text-secondary'}`}>
          {text.length}/{MAX_TEXT_LENGTH}
        </p>
      )}
    </div>
  );
}
