# Chrome extension — click-to-call + quick lead capture

Manifest V3, **no build step**. Full behaviour, API and deploy notes: **[`docs/browser-extension.md`](../docs/browser-extension.md)** (backend: `supabase/functions/browser-extension`, shared logic `supabase/functions/_shared/browser-extension/`).

## Layout
`manifest.json` · `background.js` (service worker: session, API calls, context menus) · `content.js` (page script) · `popup.html/js/css` · `lib/` (config, session, api, phone parsing) · `_locales/` · `extension.test.js` (Vitest, run by the repo's `npm test`).

## Permissions — what each is for
| Manifest entry | Why (verify in code before publishing) |
|---|---|
| `storage` | Session tokens in `chrome.storage.local`, owned by the service worker only (`background.js`, `lib/session.js`) |
| `contextMenus` | "Call" and "Capture lead" actions on selected text, links and pages |
| `activeTab` | Read the current page origin + path when capturing a lead |
| host `https://*.supabase.co/*` | Calls to the Supabase API / edge function |
| content script on `http(s)://*/*` | Detects phone numbers and `tel:` links on any page (`lib/phone.js`). Broad by nature — keep the Chrome Web Store "single purpose" and privacy disclosure aligned with it |

## Privacy facts to disclose (from `docs/browser-extension.md`)
Only the page origin + path is stored with a lead (query/hash stripped); tokens never reach content scripts; events are stored in `browser_extension_events` (optional prune job in the doc).

## Test and publish
```bash
npm test -- chrome-extension          # from the repo root
```
Publish: bump `version` in `manifest.json`, zip the contents of `chrome-extension/` (excluding `extension.test.js`), upload in the Chrome Web Store developer dashboard, complete the privacy and single-purpose forms using the tables above. Fill `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `APP_URL` in `lib/config.js` (they are placeholders in the repo; `isConfigured()` must be true; the anon key is public by design, never use a service-role key) before zipping.
