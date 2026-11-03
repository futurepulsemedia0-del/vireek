import { Languages } from 'lucide-react';
import { INTERP_META, normalizeInterpLang } from '@/lib/interpreter';

interface Props {
  lang: string | null | undefined;
  /** Interpreter mode, shown as a tooltip suffix. */
  mode?: string | null;
  degraded?: boolean;
}

/** Small pill: the language the caller speaks. Renders nothing for English / unknown. */
export function LanguageBadge({ lang, mode, degraded }: Props) {
  const code = normalizeInterpLang(lang);
  if (!code || code === 'en') return null;
  const meta = INTERP_META[code];
  const title = `${meta.name}${mode ? ` · ${mode.replace('_', ' ')}` : ''}${degraded ? ' · captions only (latency)' : ''}`;
  return (
    <span
      title={title}
      aria-label={`Caller language: ${meta.name}`}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${degraded ? 'bg-warning-500/10 text-warning-500' : 'bg-accent/10 text-accent'}`}
    >
      <Languages size={11} aria-hidden />
      <span lang={code} dir={meta.dir}>{meta.nativeName}</span>
    </span>
  );
}
