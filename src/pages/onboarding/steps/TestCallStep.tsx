import { useEffect, useRef, useState } from 'react';
import { Mic, PhoneCall, PhoneOff } from 'lucide-react';
import { StepShell } from '../StepShell';
import type { StepProps } from '../types';
import { getVapiClient, VAPI_DEMO_ASSISTANT_ID } from '@/lib/vapi';

type CallState = 'idle' | 'connecting' | 'active' | 'ended' | 'error';

export function TestCallStep({ data, update, onBack, onNext, onSkip, saving }: StepProps) {
  const [callState, setCallState] = useState<CallState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const listenersBound = useRef(false);

  useEffect(() => {
    const vapi = getVapiClient();
    if (!listenersBound.current) {
      listenersBound.current = true;
      vapi.on('call-start', () => setCallState('active'));
      vapi.on('call-end', () => {
        setCallState('ended');
        update({ testCallCompleted: true });
      });
      vapi.on('error', (err: unknown) => {
        setErrorMsg(err instanceof Error ? err.message : 'The test call could not connect.');
        setCallState('error');
      });
    }
    return () => {
      vapi.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startCall = async () => {
    setErrorMsg('');
    setCallState('connecting');
    try {
      await getVapiClient().start(VAPI_DEMO_ASSISTANT_ID, {
        variableValues: {
          company_name: data.companyName || 'your business',
          assistant_name: data.assistantName || 'Sarah',
          greeting_script:
            data.greetingScript ||
            `Thanks for calling ${data.companyName || 'us'}, this is ${data.assistantName || 'Sarah'} — how can I help?`,
          industry: data.primaryIndustry || 'home services',
          services: data.services.join(', ') || 'general services',
        },
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'The test call could not connect.');
      setCallState('error');
    }
  };

  const endCall = () => {
    getVapiClient().stop();
  };

  return (
    <StepShell
      stepKey="test_call"
      icon={PhoneCall}
      title={`Try a live call with ${data.assistantName || 'Sarah'}`}
      description="Hear exactly what your callers will hear, using the details you just set up."
      onBack={onBack}
      onNext={onNext}
      onSkip={onSkip}
      nextLabel={data.testCallCompleted ? 'Continue' : 'Skip this for now'}
      saving={saving}
    >
      <div className="flex flex-col items-center rounded-2xl border border-border bg-bg-primary p-8 text-center">
        <span
          className={`flex h-16 w-16 items-center justify-center rounded-full transition-all ${
            callState === 'active' ? 'animate-pulse bg-success-500/15 text-success-500' : 'bg-accent/10 text-accent'
          }`}
        >
          <Mic size={28} />
        </span>

        <p className="mt-4 text-sm font-medium text-text-primary">
          {callState === 'idle' && 'Ready when you are — this uses your microphone.'}
          {callState === 'connecting' && 'Connecting…'}
          {callState === 'active' && `${data.assistantName || 'Sarah'} is listening.`}
          {callState === 'ended' && 'Nice! That was Sarah handling a real conversation.'}
          {callState === 'error' && (errorMsg || 'Something interrupted the call.')}
        </p>

        <div className="mt-5">
          {callState === 'active' || callState === 'connecting' ? (
            <button
              type="button"
              onClick={endCall}
              className="focus-ring flex items-center gap-2 rounded-xl bg-danger px-5 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110"
            >
              <PhoneOff size={16} /> End call
            </button>
          ) : (
            <button
              type="button"
              onClick={startCall}
              className="focus-ring flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110"
            >
              <PhoneCall size={16} /> {callState === 'ended' ? 'Call again' : 'Start test call'}
            </button>
          )}
        </div>
      </div>
    </StepShell>
  );
}
