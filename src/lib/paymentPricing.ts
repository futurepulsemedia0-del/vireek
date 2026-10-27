// Single source of truth lives next to the edge functions; the browser re-exports it
// so the settings preview, the pay page and the server can never disagree about a fee or a discount.
export * from '../../supabase/functions/_shared/payments/pricing';
