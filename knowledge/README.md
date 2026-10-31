# knowledge/ — owner-verified docs for "Ask Vireek"

Everything the public assistant knows comes from code-generated sources **or** from markdown files in this folder.
Use this folder for anything not derivable from code: dashboard modules, API/webhook docs, mobile apps, roadmap labels.

Rules
- Only write facts you have verified. If unsure, leave it out — the assistant will then say it doesn't know and route to /contact.
- `status:` must be honest: `live`, `beta` or `planned` (the assistant labels non-live features).
- `verified:` (YYYY-MM-DD) is required; docs older than 180 days produce a build warning.
- Files starting with `_` and this README are ignored. Copy `modules/_TEMPLATE.md` to add a module.
- After editing: `npm run knowledge:build`, commit the generated files, then `npm run knowledge:embed`.
