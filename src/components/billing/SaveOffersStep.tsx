import { Gift, Loader2, PauseCircle, TrendingDown } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useChurnSaveT } from '@/i18n/churnSaveNamespace';
import type { SaveOfferView } from '@/lib/cancellation';

interface SaveOffersStepProps {
  offers: SaveOfferView[];
  busyId: string | null;
  onAccept: (offer: SaveOfferView) => void;
}

const ICONS = { pause: PauseCircle, discount: Gift, downgrade: TrendingDown } as const;

/** Renders the admin-configured save offers the server already filtered (caps, targeting, live Stripe state). */
export function SaveOffersStep({ offers, busyId, onAccept }: SaveOffersStepProps) {
  const { t, language } = useChurnSaveT();
  const money = (cents: number, currency: string) => {
    try {
      return new Intl.NumberFormat(language, { style: 'currency', currency }).format(cents / 100);
    } catch {
      return `${(cents / 100).toFixed(2)} ${currency}`;
    }
  };

  return (
    <div className="space-y-4">
      {offers.map((o) => {
        const Icon = ICONS[o.kind];
        const busy = busyId === o.id;
        const plan = o.downgrade_plan ?? '';
        const price = o.downgrade_price_cents != null && o.downgrade_currency ? money(o.downgrade_price_cents, o.downgrade_currency) : null;
        return (
          <section
            key={o.id}
            aria-label={o.name}
            className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark sm:p-6"
          >
            <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <Icon size={16} className="text-accent" aria-hidden="true" /> {t(`save.${o.kind}.title`, { months: o.pause_months ?? o.discount_months, percent: o.discount_percent, plan })}
            </p>
            <p className="mt-1 text-sm text-text-secondary">
              {t(`save.${o.kind}.body`, {
                months: o.pause_months ?? o.discount_months,
                percent: o.discount_percent,
                plan,
                minutes: o.downgrade_minutes ?? '',
                price: price ?? t('save.downgrade.priceUnknown'),
              })}
            </p>
            <Button type="button" className="mt-4 w-full sm:w-auto" onClick={() => onAccept(o)} disabled={busyId !== null}>
              {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
              {t(`save.${o.kind}.cta`)}
            </Button>
          </section>
        );
      })}
    </div>
  );
}
