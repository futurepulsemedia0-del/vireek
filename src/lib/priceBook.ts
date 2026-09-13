export type PricingModel = 'flat' | 'starting_at' | 'range' | 'hourly';

export interface PriceBookItem {
  id: string;
  user_id: string;
  service_name: string;
  category: string | null;
  pricing_model: PricingModel;
  price_cents: number;
  price_max_cents: number | null;
  unit_label: string | null;
  keywords: string[];
  description: string | null;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export const PRICING_MODEL_LABELS: Record<PricingModel, string> = {
  flat: 'Flat rate',
  starting_at: 'Starting at',
  range: 'Price range',
  hourly: 'Hourly',
};

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export function formatItemPrice(item: Pick<PriceBookItem, 'pricing_model' | 'price_cents' | 'price_max_cents' | 'unit_label'>): string {
  const unit = item.unit_label ? ` ${item.unit_label}` : '';
  switch (item.pricing_model) {
    case 'starting_at':
      return `Starting at ${formatCents(item.price_cents)}${unit}`;
    case 'range':
      return `${formatCents(item.price_cents)}–${formatCents(item.price_max_cents ?? item.price_cents)}${unit}`;
    case 'hourly':
      return `${formatCents(item.price_cents)}${unit || '/hour'}`;
    default:
      return `${formatCents(item.price_cents)}${unit}`;
  }
}

export interface PriceBookFormState {
  service_name: string;
  category: string;
  pricing_model: PricingModel;
  price: string;
  price_max: string;
  unit_label: string;
  keywords: string;
  description: string;
}

export const EMPTY_PRICE_BOOK_FORM: PriceBookFormState = {
  service_name: '',
  category: '',
  pricing_model: 'flat',
  price: '',
  price_max: '',
  unit_label: '',
  keywords: '',
  description: '',
};

export function itemToForm(item: PriceBookItem): PriceBookFormState {
  return {
    service_name: item.service_name,
    category: item.category ?? '',
    pricing_model: item.pricing_model,
    price: String(item.price_cents / 100),
    price_max: item.price_max_cents != null ? String(item.price_max_cents / 100) : '',
    unit_label: item.unit_label ?? '',
    keywords: item.keywords.join(', '),
    description: item.description ?? '',
  };
}

export function formToPayload(form: PriceBookFormState, userId: string) {
  const priceCents = Math.round(Number(form.price) * 100);
  if (!Number.isFinite(priceCents) || priceCents < 0) {
    throw new Error('Enter a valid price.');
  }

  let priceMaxCents: number | null = null;
  if (form.pricing_model === 'range') {
    priceMaxCents = Math.round(Number(form.price_max) * 100);
    if (!Number.isFinite(priceMaxCents) || priceMaxCents < priceCents) {
      throw new Error('The high end of the range must be a valid price at or above the starting price.');
    }
  }

  return {
    user_id: userId,
    service_name: form.service_name.trim(),
    category: form.category.trim() || null,
    pricing_model: form.pricing_model,
    price_cents: priceCents,
    price_max_cents: priceMaxCents,
    unit_label: form.unit_label.trim() || null,
    keywords: form.keywords.split(',').map((k) => k.trim()).filter(Boolean),
    description: form.description.trim() || null,
  };
}
