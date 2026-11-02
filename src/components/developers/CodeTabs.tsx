import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Copy } from 'lucide-react';

export interface CodeTab {
  id: string;
  label: string;
  source: string;
}

const LANG_KEY = 'vireek_docs_lang';
const LANG_EVENT = 'vireek:docs-lang';

function readStoredLang(): string | null {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
}

/**
 * Language tabs with a copy button. The chosen language is remembered and shared by every
 * CodeTabs on the page (and across visits), like Stripe/Twilio docs.
 */
export function CodeTabs({ tabs, label }: { tabs: CodeTab[]; label: string }) {
  const uid = useId();
  const [preferred, setPreferred] = useState<string | null>(() => readStoredLang());
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    const onLang = (e: Event) => setPreferred((e as CustomEvent<string>).detail);
    window.addEventListener(LANG_EVENT, onLang);
    return () => {
      window.removeEventListener(LANG_EVENT, onLang);
      clearTimeout(timer.current);
    };
  }, []);

  const active = tabs.find((t) => t.id === preferred) ?? tabs[0];

  const select = useCallback((id: string) => {
    setPreferred(id);
    try {
      localStorage.setItem(LANG_KEY, id);
    } catch {
      /* storage unavailable (private mode) — selection still works for this page */
    }
    window.dispatchEvent(new CustomEvent(LANG_EVENT, { detail: id }));
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === active.id);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    select(tabs[next].id);
    tabRefs.current[tabs[next].id]?.focus();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(active.source);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable (insecure context / denied) */
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-bg-primary">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-bg-tertiary/60 pr-2">
        <div
          role="tablist"
          aria-label={label}
          onKeyDown={onKeyDown}
          className="flex overflow-x-auto"
        >
          {tabs.map((t) => {
            const selected = t.id === active.id;
            return (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[t.id] = el;
                }}
                id={`${uid}-tab-${t.id}`}
                role="tab"
                type="button"
                aria-selected={selected}
                aria-controls={`${uid}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => select(t.id)}
                className={`focus-ring whitespace-nowrap px-4 py-2.5 text-xs font-semibold transition-colors ${
                  selected
                    ? 'border-b-2 border-accent text-text-primary'
                    : 'border-b-2 border-transparent text-text-secondary hover:text-text-primary'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Copy ${active.label} code`}
          className="focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-bg-secondary/90 px-2.5 py-1.5 text-xs font-medium text-text-secondary transition hover:text-text-primary"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${active.id}`}>
        <pre
          className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-text-primary"
          tabIndex={0}
        >
          <code>{active.source}</code>
        </pre>
      </div>
    </div>
  );
}
