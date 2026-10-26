import {
  AlertTriangle,
  Check,
  CheckCheck,
  Clock,
  CornerDownRight,
  ExternalLink,
  Phone,
} from 'lucide-react';
import { richStatusLabel, type RichStatus, type UnifiedCard } from '@/lib/unifiedInbox';

/** Delivery tick for an outbound RCS / Apple Messages message (sent, delivered, read, failed, sent as SMS). */
export function RichStatusTick({ status }: { status: RichStatus }) {
  const label = richStatusLabel(status);
  if (!label) return null;
  const Icon =
    status === 'read' || status === 'delivered'
      ? CheckCheck
      : status === 'sent'
        ? Check
        : status === 'failed'
          ? AlertTriangle
          : Clock;
  return (
    <span
      className={`ml-1.5 inline-flex items-center gap-0.5 align-middle ${status === 'read' ? 'font-semibold text-white' : ''} ${status === 'failed' ? 'text-red-200' : ''}`}
      title={label}
    >
      <Icon size={11} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

/** Renders a rich card the way the customer sees it: title, description and its buttons. */
export function RichCardView({ card, outbound }: { card: UnifiedCard; outbound: boolean }) {
  return (
    <div
      className={`-mx-1 min-w-[14rem] rounded-xl p-3 ${outbound ? 'bg-white/10' : 'bg-bg-secondary'}`}
    >
      {card.imageUrl && (
        <img
          src={card.imageUrl}
          alt=""
          loading="lazy"
          className="mb-2 h-24 w-full rounded-lg object-cover"
        />
      )}
      <p className="text-sm font-semibold">{card.title}</p>
      {card.description && (
        <p className="mt-1 whitespace-pre-line text-xs opacity-90">{card.description}</p>
      )}
      {card.actions.length > 0 && (
        <ul className="mt-2.5 space-y-1.5">
          {card.actions.map((a, i) => {
            const Icon =
              a.type === 'url' ? ExternalLink : a.type === 'call' ? Phone : CornerDownRight;
            return (
              <li
                key={`${a.label}-${i}`}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${outbound ? 'border-white/30' : 'border-border'}`}
              >
                <Icon size={12} aria-hidden="true" />
                {a.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
