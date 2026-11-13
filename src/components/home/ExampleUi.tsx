// Recreated: verify against original intent (recovered verbatim from homepage-redesign.patch)
import { exampleChip } from './sectionStyles';

/**
 * Small UI illustrations built from markup (no images, no layout shift). Every one is labelled "Example"
 * and uses made-up names. They stand in until real screenshots are supplied (see PRODUCT_SHOTS).
 */
function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-bg-primary text-start" role="img" aria-label={`Example: ${title}`}>
      <div className="flex items-center justify-between border-b border-border bg-bg-tertiary px-3 py-2">
        <span className="text-xs font-semibold text-text-primary">{title}</span>
        <span className={exampleChip}>Example</span>
      </div>
      <div className="space-y-2 p-3 text-xs text-text-secondary" aria-hidden="true">{children}</div>
    </div>
  );
}

const row = 'flex items-center justify-between rounded-lg border border-border bg-bg-secondary px-3 py-2';

export function ForwardingExample() {
  return (
    <Frame title="Call forwarding">
      <div className={row}><span>Your business line</span><strong className="text-text-primary">(555) 010-0123</strong></div>
      <div className="text-center">↓ forwards to</div>
      <div className={row}><span>Sarah</span><strong className="text-text-primary">Answering</strong></div>
    </Frame>
  );
}

export function CallExample() {
  return (
    <Frame title="Live call">
      <p className="rounded-lg bg-bg-secondary p-2 italic">“My water heater is leaking.”</p>
      <p className="rounded-lg bg-bg-tertiary p-2 italic text-text-primary">“Is water running right now? I can book someone today.”</p>
      <div className={row}><span>Flagged</span><strong className="text-text-primary">Emergency</strong></div>
    </Frame>
  );
}

export function JobExample() {
  return (
    <Frame title="New job">
      <div className={row}><span>Customer</span><strong className="text-text-primary">J. Rivera</strong></div>
      <div className={row}><span>Issue</span><strong className="text-text-primary">Leaking water heater</strong></div>
      <div className={row}><span>When</span><strong className="text-text-primary">Today, 2:30 PM</strong></div>
      <div className={row}><span>Confirmation</span><strong className="text-text-primary">Text sent</strong></div>
    </Frame>
  );
}

export function RecoverExample() {
  return (
    <Frame title="Follow-up">
      <div className={row}><span>Missed call</span><strong className="text-text-primary">9:41 PM</strong></div>
      <p className="rounded-lg bg-bg-tertiary p-2 italic text-text-primary">“Sorry we missed you. What do you need help with?”</p>
      <div className={row}><span>Status</span><strong className="text-text-primary">Reply received</strong></div>
    </Frame>
  );
}

export function DispatchExample() {
  return (
    <Frame title="Schedule">
      <div className={row}><span>10:00</span><strong className="text-text-primary">Estimate · Oak St</strong></div>
      <div className={row}><span>12:30</span><strong className="text-text-primary">Install · Pine Ave</strong></div>
      <div className={row}><span>14:30</span><strong className="text-text-primary">Emergency · Elm Rd</strong></div>
    </Frame>
  );
}
