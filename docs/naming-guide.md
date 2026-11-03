# Vireek naming guide

Goal: a plumber understands any label in 10 seconds.

1. **Say the outcome, not the mechanism.** "Demand Forecast", not "Event Prediction Mesh".
2. **Plain trade words.** Job, quote, invoice, call, crew, truck, part. No metaphors (mesh, immune, genome, flywheel, fabric, twin, entropy).
3. **Nouns for places, verbs for actions.** Page: "Invoices". Button: "Send invoice".
4. **Max 3 words per nav label.** Put detail in the page subtitle.
5. **One name per thing.** Before adding a page, search `docs/surface-inventory.csv` for an overlap and extend it instead.
6. **Experimental means Labs.** New unverified pages go in `labs` in `surface.manifest.json` and show a Beta badge.
7. **Never break a URL.** Rename labels, not routes. If a route must change, add a 301 and keep the old path routed.
8. **Old names stay searchable.** Every rename lists `old` plus `synonyms` in the manifest.
9. **Pick one pillar:** Answer, Book & Dispatch, Grow & Get Paid (or Settings).
