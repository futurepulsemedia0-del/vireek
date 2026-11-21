/*
  # Personalized-pricing notice: feature flag (default OFF)

  Adds the `personalized_pricing_notice` flag that gates src/components/pricing/PersonalizedPricingNotice.tsx.
  Idempotent: re-running changes nothing and never flips an existing row (a staff decision stays).

  Rollback (manual, only if the component has been removed first):
    DELETE FROM public.feature_flags WHERE key = 'personalized_pricing_notice';
*/

INSERT INTO public.feature_flags (key, name, description, enabled, rollout_pct)
VALUES (
  'personalized_pricing_notice',
  'Personalized-pricing notice',
  'When OFF (default) no pricing notice is shown. When ON, prices produced from the buyer''s location, account or equipment data show a plain-language notice. Wording and jurisdictions are pending counsel review (docs/compliance/pricing-personalization.md). Owner: compliance. Permanent ops switch.',
  false, 0
)
ON CONFLICT (key) DO NOTHING;
