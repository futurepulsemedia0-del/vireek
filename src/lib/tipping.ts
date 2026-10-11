// Single source of truth lives next to the edge functions; the browser re-exports it
// so the UI preview and the server can never disagree about a tip amount.
export * from '../../supabase/functions/_shared/payments/tip';
