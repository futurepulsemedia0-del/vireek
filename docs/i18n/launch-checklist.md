# Language Launch Checklist

To promote a language to Tier A/B or to remove its Beta label, every item below must be checked off.

- [ ] `npm run i18n:coverage` passes with no errors (threshold: `minCoverage` in `src/i18n/locales.config.ts`)
- [ ] `npm run i18n:coverage:release` (`--strict` mode) passes with no errors: every legal, consent, emergency and AI-disclosure key is recorded in `docs/i18n/reviewed-keys.json` under a named native reviewer
- [ ] `npm run i18n:freshness` reports no stale translations on the covered surfaces
- [ ] Legal counsel has approved the recording-consent text, AI disclosure, opt-out keywords and A2P/TCPA templates
- [ ] Native reviewer (name/date): ________
- [ ] Pseudo-localization run and key screens checked visually (overflow, RTL for ar/fa)
- [ ] PDFs (invoice/quote/receipt) tested with a font that covers that language's script
- [ ] Support macros and legal pages are ready
- [ ] Remove the Beta label only after all items above are confirmed
