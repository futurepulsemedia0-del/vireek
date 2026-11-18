import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Send, Square } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { useAskT } from '@/i18n/askVireekNamespace';
import { MAX_INPUT_CHARS } from '@/lib/askVireek/useAskVireekChat';

interface Props {
  busy: boolean;
  prefill?: string;
  onSend: (text: string) => void;
  onStop: () => void;
  autoFocus: boolean;
}

export function AskVireekComposer({ busy, prefill, onSend, onStop, autoFocus }: Props) {
  const { t } = useAskT();
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();

  useEffect(() => {
    if (prefill) setValue(prefill.slice(0, MAX_INPUT_CHARS));
  }, [prefill]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`; // ds-allow: auto-grow textarea height is measured, not static
  }, [value]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const left = MAX_INPUT_CHARS - value.length;
  const send = () => {
    const text = value.trim();
    if (!text || busy) return;
    onSend(text);
    setValue('');
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="border-t border-border bg-bg-secondary p-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          dir="auto"
          rows={1}
          value={value}
          maxLength={MAX_INPUT_CHARS}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
          aria-label={t('composer.label')}
          aria-describedby={hintId}
          placeholder={t('composer.placeholder')}
          className="focus-ring max-h-32 min-h-touch flex-1 resize-none rounded-control border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary"
        />
        {busy ? (
          <IconButton label={t('composer.stop')} icon={Square} variant="secondary" onClick={onStop} />
        ) : (
          <IconButton label={t('composer.send')} icon={Send} variant="primary" disabled={!value.trim()} onClick={send} />
        )}
      </div>
      <p id={hintId} className="mt-1.5 px-1 text-xs text-text-secondary">
        {left <= 100 ? t('composer.limit', { count: left }) : t('composer.hint')}
      </p>
    </div>
  );
}
