import { useEffect, useRef, useState } from 'react';
import { Loader as Loader2, Rocket } from 'lucide-react';
import type { StepProps } from '../types';

interface LaunchStepProps extends StepProps {
  onLaunch: () => Promise<void>;
  onFinish: () => void;
  launched: boolean;
}

export function LaunchStep({ data, onLaunch, onFinish, launched, saving }: LaunchStepProps) {
  const [triggered, setTriggered] = useState(false);
  const hasRun = useRef(false);

  useEffect(() => {
    if (!hasRun.current) {
      hasRun.current = true;
      setTriggered(true);
      onLaunch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="text-center">
      <span
        className={`inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/10 text-accent ${
          launched ? '' : 'animate-pulse'
        }`}
      >
        <Rocket size={30} />
      </span>
      <h1 className="mt-4 text-xl font-bold tracking-tight text-text-primary sm:text-2xl">
        {launched ? `${data.assistantName || 'Sarah'} is live!` : 'Launching your account…'}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-text-secondary">
        {launched
          ? `Every call to ${data.companyName || 'your business'} is now handled by ${data.assistantName || 'Sarah'}. Fine-tune anything from your dashboard whenever you like.`
          : 'Saving your setup, provisioning your phone number, and publishing your knowledge base.'}
      </p>

      <div className="mt-8">
        {launched ? (
          <button
            type="button"
            onClick={onFinish}
            className="focus-ring inline-flex items-center gap-2 rounded-xl bg-cta px-6 py-3 text-sm font-semibold text-white transition-all hover:brightness-110"
          >
            Go to Dashboard
          </button>
        ) : (
          <div className="flex items-center justify-center gap-2 text-sm text-text-secondary">
            <Loader2 size={16} className="animate-spin" /> {triggered && saving ? 'Working on it…' : 'Almost there…'}
          </div>
        )}
      </div>
    </div>
  );
}
