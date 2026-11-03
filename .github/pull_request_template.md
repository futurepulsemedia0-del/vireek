## Summary

## Product surface checklist (skip if no new page/route/nav item)
- [ ] Label follows `docs/naming-guide.md` (plain words, outcome-based, no metaphors, max 3 words)
- [ ] Added to exactly one pillar rule in `src/lib/surface/surface.manifest.json` (or to `labs` if unverified)
- [ ] Checked `docs/surface-inventory.csv` for an existing page that overlaps
- [ ] If renamed: `old` name + `synonyms` added to `renames` and the URL is unchanged
- [ ] `node scripts/gen-surface-inventory.mjs --check` passes (no unclassified or unrouted nav links)
- [ ] Plan/permission gating unchanged or explained
