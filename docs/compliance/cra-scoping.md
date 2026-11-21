# EU Cyber Resilience Act (CRA): scoping inventory

Owner: designated legal contact and security lead (to be named) **[COUNSEL]**.
Status: **DRAFT engineering inventory. This is not legal advice and makes no compliance claim.**
Snapshot: repository ZIP of 2026-11-17, static inspection only. Nothing was built, run or published to produce this file.

Markers used in this file:

- **[COUNSEL]** a legal conclusion. Engineering only supplies the facts; counsel decides.
- **[VERIFY]** a fact or date that was not confirmed against a primary source, or that cannot be confirmed from the repository.
- "Working hypothesis" is the engineering team's reading, kept only so counsel has a starting point. It is not a classification.

## 1. Why this file exists

Regulation (EU) 2024/2847 (the CRA) concerns "products with digital elements" made available on the EU market. Its
vulnerability and incident reporting duties (Art. 14) are reported by secondary sources to have applied since
**11 September 2026**, while most other duties (security requirements, conformity assessment, CE marking) are reported to
apply from **11 December 2027** **[VERIFY against the Regulation text on EUR-Lex, Art. 71]**.
Reporting duties are reported to cover products already on the market, not only new ones **[VERIFY]**. If any Vireek
artifact is in scope, the reporting clocks may already be running, so the classification below is time-sensitive.

Vireek is a SaaS company. Whether a distributed client of a SaaS is a "product" and whether Vireek is its "manufacturer"
are the questions to settle first. This file lists what Vireek actually distributes so counsel can answer them.

## 2. Facts that apply to every artifact

| Fact | Evidence | Note |
|---|---|---|
| Vireek designs and builds all listed artifacts itself | `package.json`, `capacitor.config.ts`, `chrome-extension/`, `packages/*` | Counsel to decide whether this makes Vireek the "manufacturer". **[COUNSEL]** |
| Source is proprietary, not open source | `LICENSE` ("All rights reserved") | The CRA's open-source provisions are therefore not a starting assumption. **[COUNSEL]** |
| Vireek ships no hardware and no firmware | No firmware in the repository; device integrations consume third-party devices | Re-check before any branded sensor or gateway is sold. **[VERIFY]** |
| Backend for the clients is operated by Vireek | `supabase/functions/*`, `worker/index.ts` | A backend can matter as a "remote data processing solution" of a client. **[COUNSEL]** |
| Commercial activity | Paid plans exist (`docs/plan-enforcement-matrix.md`) | Free apps that support a paid service may still be "in the course of a commercial activity". **[COUNSEL]** |
| EU availability | Distribution countries are set in the store consoles, not in the repository | **[VERIFY]** In Play Console, App Store Connect, Chrome Web Store. |

## 3. Inventory

"Distributed" means code or a file that runs on a device Vireek does not operate. "Hosted" means code that runs only on
infrastructure Vireek operates. The **Key** column is the value used in `vulnerability_reports.affected_artifacts`.

| # | Artifact | Key | Distributed or hosted | Distribution channel | Version evidence |
|---|---|---|---|---|---|
| A1 | **Vireek Field** (`com.vireek.field`): Capacitor app for Android and iOS, with iOS widgets | `mobile_field_app` | Distributed | Google Play, Apple App Store (via `docs/MOBILE_RELEASE.md`) **[VERIFY]** | `android/app/build.gradle` (`versionName` from env), Xcode project (not inspected) |
| A2 | **Vireek Home** (`com.vireek.home`): same codebase, own bundle id | `mobile_home_app` | Distributed | Same stores **[VERIFY]** | `capacitor.config.ts` (`VIREEK_APP=home`). `android-home/` and `ios-home/` are **not in this snapshot** |
| A3 | **Chrome extension** (click-to-call, lead capture) | `chrome_extension` | Distributed | Chrome Web Store, per `docs/browser-extension.md` **[VERIFY]** | `chrome-extension/manifest.json` version `1.0.0` |
| A4 | **`@vireek/sdk`** (typed API client) | `sdk` | Distributed when published | README says "Not published to npm yet" **[VERIFY]** | `packages/sdk/package.json` version `0.1.0` |
| A5 | **`@vireek/cli`** | `cli` | Distributed when published | `package.json` has `"private": true` **and** `publishConfig.access: public`. Which is intended must be confirmed **[VERIFY]** | `packages/cli/package.json` version `0.1.0` |
| A6 | **Website embeds**: `public/chat-widget.js`, `public/dni.js`, `public/website-widgets.js`, `public/embed/badge.v1.js`, `public/embed/analytics.js` | `website_embeds` | Served by Vireek, executed in customers' websites and visitors' browsers | Script tag loaded from Vireek's host | Files carry no version except `badge.v1` |
| A7 | **Device ingest endpoints**: `iot-ingest`, `rr-device-ingest` (third-party sensors and gateways post readings with a device key) | `device_ingest` | Hosted. The devices are third-party | Not distributed | `supabase/functions/iot-ingest/index.ts`, `rr-device-ingest/index.ts` |
| A8 | **Interpreter bridge** (`services/interpreter-bridge`, Node 22 container) | `interpreter_bridge` | Hosted by Vireek (a Dockerfile exists; who runs it is **[VERIFY]**) | Not distributed | `services/interpreter-bridge/Dockerfile` |
| A9 | **Web app / PWA**, Cloudflare worker, edge functions, **public API** (`api-v1`), **MCP server** | `web_app_pwa`, `edge_functions`, `public_api`, `mcp_server` | Hosted | Not distributed (a PWA runs in the browser but is delivered as a service) | `vercel.json`, `wrangler.jsonc`, `supabase/functions/*` |

### 3.1 Device integrations (inside A1 and A7)

None of these is a Vireek-made device. Each is software that talks to someone else's hardware or service.

| Integration | Where | What Vireek ships | Third-party party |
|---|---|---|---|
| Bluetooth LE instruments (thermometers, environmental sensors; vendor profiles possible) | `src/lib/native/bluetooth.ts`, `instruments.ts`, `docs/BLUETOOTH_INSTRUMENTS.md`, plugin `@capacitor-community/bluetooth-le` | Reader code inside A1 | Instrument manufacturers |
| NFC tag reading | `src/lib/native/nfc.ts`, plugin `@capgo/capacitor-nfc` | Reader code inside A1 | Tag vendors |
| Card readers / Tap to Pay | plugin `@capacitor-community/stripe-terminal`, `NFCReaderUsageDescription` in `Info.plist` | Integration code inside A1. Entitlement status not visible in the snapshot **[VERIFY]** | Stripe (reader hardware and SDK) |
| Barcode scanning | plugin `@capacitor-mlkit/barcode-scanning` | Code inside A1 | Google ML Kit |
| Background location | plugin `@capgo/background-geolocation` | Code inside A1 | Plugin author |
| Push | plugin `@capacitor-firebase/messaging`, `firebase` | Code inside A1 and A2 | Google Firebase |
| Sensors and gateways posting to ingest endpoints | A7 | Only the receiving endpoint. Device keys are stored as SHA-256 hashes | Sensor and gateway manufacturers |
| Wallet passes | `supabase/functions/wallet-issue`, `wallet-pass`, `wallet-sync` | Pass files (data) issued by the backend, not an installed program | Apple and Google wallets |

## 4. Classification per artifact

Two columns. The **working hypothesis** is the engineering reading from the facts above and may be wrong. The
**classification** column is intentionally empty: it is a legal decision.

| # | Working hypothesis (engineering) | Classification **[COUNSEL]** | Questions counsel must answer |
|---|---|---|---|
| A1 | Software that runs on the customer's own device and is distributed through stores. Most likely a "product with digital elements" if made available in the EU in the course of commercial activity. | _pending_ | Is Vireek the manufacturer? Is the free app part of a commercial activity? Does the Vireek backend count as a "remote data processing solution" of the app? Which, if any, Annex III class could apply (default, important, critical)? |
| A2 | Same as A1, but the snapshot lacks its native projects, so the facts are incomplete. | _pending_ | Same as A1. Plus: is Home offered to consumers rather than businesses, and does that change any duty? |
| A3 | A browser extension delivered by a store. Probably a product with digital elements if made available in the EU. It is not a browser itself. | _pending_ | Does any Annex III category apply to an extension that handles an authentication session token? **[VERIFY]** |
| A4 | A software library. Not yet published, so possibly not "made available on the market" today. | _pending_ | At what point does publishing to npm make Vireek a manufacturer of a component? Would a public package under `UNLICENSED` change anything? |
| A5 | A command-line tool. Release status unclear (see table: `private` vs `publishConfig`). | _pending_ | Same as A4. Decide whether it is released at all before classifying. |
| A6 | Scripts served from Vireek's host and run inside customers' sites. Closer to a service delivered over the web than an installed product, but they are code executed on third-party endpoints. | _pending_ | Are these part of a remote data processing solution, a product in themselves, or neither? |
| A7 | A hosted endpoint. The devices belong to others. | _pending_ | Does Vireek become the manufacturer of anything by issuing device keys? Likely not, but counsel decides. |
| A8 | Hosted service. | _pending_ | Whether it is in scope at all. Counsel should also consider the NIS2 position of the service as a whole. **[COUNSEL]** |
| A9 | Hosted SaaS and APIs. Pure SaaS is reported to be outside the CRA unless it is the remote data processing solution of a product. | _pending_ | Confirm, and confirm which of A1 to A6 each backend function supports. |
| 3.1 | Third-party hardware, so Vireek is a user of the hardware, not its manufacturer. Vireek is responsible for its own reader code. | _pending_ | Whether Stripe Terminal integration creates any duty beyond Stripe's own. |

Every artifact marked in scope by counsel needs its own row in the table of section 6, filled in by the security lead.

## 5. Obligations to plan for once an artifact is in scope **[COUNSEL] [VERIFY]**

This is a planning list from secondary summaries, not an analysis of the Regulation.

1. **Reporting** actively exploited vulnerabilities and severe incidents: early warning, notification, final report.
   Process, clocks and templates: `docs/compliance/cra-vulnerability-handling.md`. Register: table `vulnerability_reports`.
2. **Coordinated vulnerability disclosure policy and a contact address.** `SECURITY.md`, `public/.well-known/security.txt`
   and `/vulnerability-disclosure` already exist. Their wording needs counsel review. The response targets disagree today:
   `SECURITY.md` says 3 and 7 business days, the public page says 2 and 5.
3. **Security update delivery** for the support period. Mobile and extension updates depend on store review; the repository
   already has `docs/mobile/store-risk-register.md` and `src/lib/native/appUpdate.ts`.
4. **Software bill of materials.** `package.json` defines `npm run sbom` pointing at `scripts/supply-chain/sbom.mjs`, but that
   file is **not in this snapshot**. License checks exist (`scripts/supply-chain/license-check.mjs`). **[VERIFY]**
5. **Technical documentation, risk assessment and conformity assessment** at the point the main duties apply.
6. **Information to users** (instructions, support period, contact point).
7. **Supplier due diligence** on third-party components (Capacitor plugins, Firebase, Stripe Terminal, ML Kit, Sentry).

## 6. Per-artifact record (to fill in once counsel classifies)

Copy this block for each artifact in scope.

```
Artifact id / key:
Classification (counsel decision, date, reference):
Manufacturer entity:
EU member states where made available:
Support period decision:
Single contact point for vulnerabilities:
SBOM location and last generation date:
Last security update date:
Open vulnerability_reports (reference list):
```

## 7. Open items

| # | Item | Owner |
|---|---|---|
| 1 | Counsel classification of A1 to A9 and 3.1 | Legal |
| 2 | Confirm EU availability per store console | Mobile / release owner |
| 3 | Decide whether `@vireek/cli` is released (`private` vs `publishConfig`) | Developer experience |
| 4 | Locate or restore `scripts/supply-chain/sbom.mjs` (missing from the snapshot) | Platform |
| 5 | Supply `android-home/` and `ios-home/` facts for Home | Mobile |
| 6 | Align the response targets in `SECURITY.md` and `/vulnerability-disclosure` | Security + Legal |
| 7 | Confirm every date and hour count above against EUR-Lex and the Commission's reporting guidance | Legal |
| 8 | Confirm who operates the interpreter bridge | Platform |
