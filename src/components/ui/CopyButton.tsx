// src/components/ui/CopyButton.tsx
//
// The one copy control. Inline confirmation (icon morph + label swap), no toast.
// Both labels share one grid cell, so the button never changes width.
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { useCopy } from '@/hooks/useCopy';

export interface CopyButtonProps {
  text: string | (() => string);
  label?: string;
  copiedLabel?: string;
  variant?: 'secondary' | 'ghost';
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}

const swap = 'transition-[opacity,transform] duration-base ease-out-expo motion-reduce:transition-none';

export function CopyButton({ text, label, copiedLabel, variant = 'secondary', size = 'xs', className = '' }: CopyButtonProps) {
  const { t } = useTranslation();
  const { status, copy } = useCopy();
  const idle = label ?? t('ui.copy', { defaultValue: 'Copy' });
  const done = copiedLabel ?? t('ui.copied', { defaultValue: 'Copied' });
  const failedText = t('ui.copyFailed', { defaultValue: 'Copy failed' });
  const statusIndex = status === 'copied' ? 1 : status === 'failed' ? 2 : 0;

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      data-copy-status={status}
      onClick={() => void copy(typeof text === 'function' ? text() : text)}
    >
      <span className="relative inline-flex h-4 w-4 shrink-0" aria-hidden="true">
        <Copy size={16} className={`absolute inset-0 ${swap} ${status === 'idle' ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`} />
        <Check size={16} className={`absolute inset-0 text-success-500 ${swap} ${status === 'copied' ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`} />
      </span>
      {/* grid-stacked labels: width = the widest one */}
      <span className="grid">
        {[idle, done, failedText].map((labelText, i) => (
          <span
            key={i}
            aria-hidden={i !== statusIndex || undefined}
            className={`[grid-area:1/1] ${swap} ${i === statusIndex ? 'opacity-100' : 'opacity-0'} ${i === 2 && i === statusIndex ? 'text-danger' : ''}`}
          >
            {labelText}
          </span>
        ))}
      </span>
    </Button>
  );
}
