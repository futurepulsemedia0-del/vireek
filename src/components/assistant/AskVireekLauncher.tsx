import { useEffect, useState } from 'react';
import { MessageCircleQuestion, X } from 'lucide-react';
import { useAskT } from '@/i18n/askVireekNamespace';
import { surfaceClass } from '@/lib/ui/interaction';
import { getSupportStatus } from '@/lib/supportHours';
import { hasSeenIntro, markIntroSeen } from '@/lib/askVireek/storage';

interface Props {
  open: boolean;
  unread: boolean;
  onToggle: () => void;
}

const INTRO_MS = 9000;

/** The ONE floating launcher. Bottom-end corner (logical, so it mirrors in RTL), lifted above bottom bars. */
export function AskVireekLauncher({ open, unread, onToggle }: Props) {
  const { t } = useAskT();
  const [intro, setIntro] = useState(false);
  const online = getSupportStatus().online;

  useEffect(() => {
    if (hasSeenIntro()) return;
    const show = window.setTimeout(() => setIntro(true), 1500);
    return () => window.clearTimeout(show);
  }, []);

  useEffect(() => {
    if (!intro) return;
    const hide = window.setTimeout(() => {
      setIntro(false);
      markIntroSeen();
    }, INTRO_MS);
    return () => window.clearTimeout(hide);
  }, [intro]);

  useEffect(() => {
    if (open && intro) {
      setIntro(false);
      markIntroSeen();
    }
  }, [open, intro]);

  const dismiss = () => {
    setIntro(false);
    markIntroSeen();
  };

  return (
    <div className="pointer-events-none fixed end-4 z-overlay flex items-center gap-2 bottom-[calc(1rem+env(safe-area-inset-bottom)+var(--vk-bottom-nav-h,0px)+var(--vk-bottom-bar-h,0px))] sm:end-5 print:hidden">
      {intro && !open && (
        <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-bg-secondary py-1 ps-4 pe-1 text-sm font-medium text-text-primary shadow-elevation-2" role="status">
          {t('launcher.intro')}
          <button type="button" onClick={dismiss} aria-label={t('launcher.introDismiss')} className="focus-ring flex h-8 w-8 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={onToggle}
        aria-label={open ? t('launcher.close') : t('launcher.open')}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('launcher.shortcutHint')}
        className={`${surfaceClass('solid')} focus-ring pointer-events-auto relative flex h-14 w-14 items-center justify-center rounded-full shadow-elevation-3 transition-transform duration-base hover:-translate-y-0.5`}
      >
        {open ? <X size={22} aria-hidden="true" /> : <MessageCircleQuestion size={24} aria-hidden="true" />}
        {!open && (
          <span className="absolute end-0.5 top-0.5 flex h-3 w-3" aria-hidden="true">
            <span className={`h-3 w-3 rounded-full border-2 border-bg-secondary ${unread ? 'bg-cta' : online ? 'bg-success-500' : 'bg-text-muted'}`} />
          </span>
        )}
      </button>
    </div>
  );
}
