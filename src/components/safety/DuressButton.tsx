// Recreated: verify against original intent
import { useEffect, useRef, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { queueAction, raiseDuress } from '@/lib/siteSafety';

interface Props {
  sessionId: string;
  onRaised?: () => void;
}

const HOLD_MS = 1500;

/**
 * Silent duress alert. Two ways to trigger it so it works with gloves, a wet screen and assistive tech:
 *  - press and HOLD for 1.5 s (no confirm), or
 *  - activate with a tap / Enter / Space, then confirm in a second step (keyboard, TalkBack and VoiceOver path).
 * If the network is down the alert is queued and replayed first when the connection returns.
 */
export function DuressButton({ sessionId, onRaised }: Props) {
  const [holding, setHolding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'queued'>('idle');
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const sending = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const send = async () => {
    if (sending.current) return; // never raise twice from one gesture
    sending.current = true;
    setConfirming(false);
    setState('sending');
    try {
      await raiseDuress(sessionId);
      if (alive.current) setState('sent');
    } catch {
      queueAction({ kind: 'duress', sessionId, at: Date.now() });
      if (alive.current) setState('queued');
    } finally {
      sending.current = false;
      onRaised?.();
    }
  };

  const startHold = () => {
    if (state !== 'idle') return;
    fired.current = false;
    setHolding(true);
    timer.current = window.setTimeout(() => {
      fired.current = true;
      setHolding(false);
      void send();
    }, HOLD_MS);
  };
  const cancelHold = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };

  if (state === 'sent' || state === 'queued') {
    return (
      <p role="status" className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm font-semibold text-danger">
        {state === 'sent'
          ? 'Alert sent to your team. Call your local emergency number if you are in danger.'
          : 'No signal: your alert is saved and will be sent as soon as you are back online. Call your local emergency number if you are in danger.'}
      </p>
    );
  }

  return (
    <div>
      {confirming ? (
        <div role="alertdialog" aria-label="Confirm duress alert" className="rounded-xl border border-danger/40 bg-danger/5 p-3">
          <p className="text-sm font-semibold text-text-primary">Send a silent duress alert to your team?</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => setConfirming(false)} className="focus-ring min-h-[48px] flex-1 rounded-lg border border-border px-3 text-sm font-semibold text-text-primary">Cancel</button>
            <button type="button" onClick={() => void send()} className="focus-ring min-h-[48px] flex-1 rounded-lg bg-danger px-3 text-sm font-semibold text-white">Send alert</button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={state === 'sending'}
          aria-label="Duress alert. Press and hold for one and a half seconds, or activate and then confirm."
          onPointerDown={startHold}
          onPointerUp={cancelHold}
          onPointerLeave={cancelHold}
          onPointerCancel={cancelHold}
          onContextMenu={(e) => e.preventDefault()}
          onClick={() => {
            if (fired.current) { fired.current = false; return; } // the hold already sent it
            setConfirming(true);
          }}
          className={`focus-ring relative flex min-h-[56px] w-full touch-none select-none items-center justify-center gap-2 overflow-hidden rounded-xl border-2 border-danger px-4 text-sm font-bold text-danger ${holding ? 'bg-danger/20' : 'bg-danger/5'}`}
        >
          {holding && <span aria-hidden="true" className="absolute inset-y-0 start-0 bg-danger/30" style={{ animation: `duress-fill ${HOLD_MS}ms linear forwards` }} />}
          <ShieldAlert size={18} aria-hidden="true" className="relative" />
          <span className="relative">{state === 'sending' ? 'Sending…' : holding ? 'Keep holding…' : 'Duress — hold to alert'}</span>
        </button>
      )}
      <style>{'@keyframes duress-fill{from{width:0}to{width:100%}} @media (prefers-reduced-motion: reduce){[style*="duress-fill"]{animation:none!important;width:100%}}'}</style>
    </div>
  );
}
