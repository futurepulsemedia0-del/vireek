#!/usr/bin/env node
// scripts/gen-provider-docs.mjs
//
// Generates docs/integrations/providers/<provider>.md (+ README.md) for every third-party provider found in
// supabase/functions, _shared and src/lib: secrets/env vars and who reads them, the edge functions that talk to the
// provider, inbound webhook/callback endpoints with detected signature checks, outbound API hosts, handled webhook
// event types (Stripe), shared modules, existing docs that discuss it, and a setup checklist built from those facts.
// What the code cannot know (dashboard owner, granted scopes, sandbox account, rotation date, DPA) lives in the
// hand-edited docs/integrations/providers/OWNER_REGISTER.md, which this script never overwrites.
// Static regex scan. Usage: npm run docs:providers  (or -- --check)

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CHECK = process.argv.includes('--check')
const OUT = 'docs/integrations/providers'
const read = (p) => readFileSync(p, 'utf8')
const walk = (d) =>
  !existsSync(d) ? [] : readdirSync(d).flatMap((n) => {
    const p = join(d, n)
    return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : [p]
  })
const esc = (s) => String(s).replace(/\|/g, '\\|')
const code = (xs) => (xs.length ? xs.map((x) => `\`${esc(x)}\``).join(', ') : '—')

// code = text pattern, env = env-var name pattern, host = API host pattern. Order = display order.
const PROVIDERS = [
  ['Stripe', 'stripe', /stripe/i, /^STRIPE_/, /stripe\.com$/],
  ['Twilio', 'twilio', /twilio/i, /^TWILIO_/, /twilio\.com$/],
  ['Vapi', 'vapi', /\bvapi\b/i, /^VAPI_/, /vapi\.ai$/],
  ['Telnyx', 'telnyx', /telnyx/i, /^TELNYX_/, /telnyx\.com$/],
  ['Resend', 'resend', /resend/i, /^RESEND_/, /resend\.com$/],
  ['OpenAI', 'openai', /openai/i, /^OPENAI_/, /openai\.com$/],
  ['Anthropic', 'anthropic', /anthropic/i, /^ANTHROPIC_/, /anthropic\.com$/],
  ['Google Gemini / AI', 'gemini', /gemini|generativelanguage/i, /^(GEMINI_|GOOGLE_AI_)/, /generativelanguage\.googleapis\.com$/],
  ['ElevenLabs', 'elevenlabs', /elevenlabs/i, /^ELEVENLABS_/, /elevenlabs\.io$/],
  ['Deepgram', 'deepgram', /deepgram/i, /^DEEPGRAM_/, /deepgram\.com$/],
  ['Google (Calendar, Business Profile, Ads, Maps)', 'google', /googleapis|google[-_ ]?(calendar|ads|business|maps)|gbp/i, /^(GOOGLE_|GBP_)/, /google(apis)?\.com$/],
  ['Microsoft (Graph, Teams, Calendar)', 'microsoft', /microsoft|graph\.microsoft/i, /^(MICROSOFT_|MS_|TEAMS_|AZURE_)/, /microsoft(online)?\.com$/],
  ['QuickBooks Online', 'quickbooks', /quickbooks|\bqbo\b/i, /^(QBO_|QUICKBOOKS_|INTUIT_)/, /intuit\.com$/],
  ['Xero', 'xero', /\bxero\b/i, /^XERO_/, /xero\.com$/],
  ['Sage Intacct', 'intacct', /intacct/i, /^INTACCT_/, /intacct\.com$/],
  ['NetSuite', 'netsuite', /netsuite/i, /^(NS_|NETSUITE_)/, /netsuite\.com$/],
  ['Plaid', 'plaid', /plaid/i, /^PLAID_/, /plaid\.com$/],
  ['Gusto / payroll connectors', 'payroll', /gusto|payroll[-_]?connector/i, /^(GUSTO_|PAYROLL_)/, /gusto\.com$/],
  ['Checkr', 'checkr', /checkr/i, /^CHECKR_/, /checkr\.com$/],
  ['Jobber', 'jobber', /jobber/i, /^JOBBER_/, /getjobber\.com$/],
  ['Housecall Pro', 'housecall-pro', /housecall/i, /^(HCP_|HOUSECALL)/, /housecallpro\.com$/],
  ['ServiceTitan', 'servicetitan', /servicetitan/i, /^(SERVICETITAN_|ST_)/, /servicetitan\.io$/],
  ['HubSpot', 'hubspot', /hubspot/i, /^HUBSPOT_/, /hubapi\.com$|hubspot\.com$/],
  ['Slack', 'slack', /slack/i, /^SLACK_/, /slack\.com$/],
  ['Meta (WhatsApp, Messenger, Facebook)', 'meta', /whatsapp|messenger|graph\.facebook/i, /^(META_|WHATSAPP_|FACEBOOK_|FB_)/, /facebook\.com$/],
  ['Telegram', 'telegram', /telegram/i, /^TELEGRAM_/, /telegram\.org$/],
  ['Zapier', 'zapier', /zapier/i, /^ZAPIER_/, /zapier\.com$/],
  ['TaxJar', 'taxjar', /taxjar/i, /^TAXJAR_/, /taxjar\.com$/],
  ['Cloudflare', 'cloudflare', /cloudflare/i, /^(CLOUDFLARE_|CF_)/, /cloudflare\.com$/],
  ['Daily.co', 'daily', /daily\.co|DAILY_API/i, /^DAILY_/, /daily\.co$/],
  ['Apple Push (APNs) / Firebase (FCM)', 'push', /apns|fcm|firebase/i, /^(APNS_|FCM_|FIREBASE_)/, /googleapis\.com$|apple\.com$/],
  ['Open-Meteo / weather', 'weather', /open-meteo|openweather/i, /^(OPENWEATHER_|WEATHER_)/, /open-meteo\.com$|openweathermap\.org$/],
]

const fnDirs = readdirSync('supabase/functions').filter((n) => statSync(join('supabase/functions', n)).isDirectory())
const fnFiles = fnDirs.flatMap((d) => walk(join('supabase/functions', d)).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f)).map((f) => [d, f, read(f)]))
const libFiles = walk('src/lib').filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f)).map((f) => [f, read(f)])
const docs = ['README.md', 'ARCHITECTURE.md', 'RUNBOOK.md', 'ENVIRONMENT.md', 'VOICE_RUNBOOK.md', 'XERO_SYNC.md', ...walk('docs').filter((f) => f.endsWith('.md') && !/^docs\/(generated|functions|integrations\/providers)\//.test(f) && !/function-matrix|SOC2_READINESS/.test(f))].filter(existsSync).map((f) => [f, read(f)])
const STRIPE_EVENT = /['"]((?:checkout|payment_intent|charge|invoice|customer|account|payout|refund|setup_intent|transfer|capital|balance)\.[a-z_]+(?:\.[a-z_]+)*)['"]/g

const files = new Map()
const summary = []
for (const [name, slug, re, envRe, hostRe] of PROVIDERS) {
  const envMap = new Map() // env -> Set(function)
  const fns = new Set()
  const hosts = new Set()
  const shared = new Set()
  const webhooks = new Map()
  const events = new Set()
  for (const [d, f, text] of fnFiles) {
    const nameHit = re.test(d)
    const envs = [...text.matchAll(/Deno\.env\.get\(\s*['"]([A-Z0-9_]+)['"]/g)].map((m) => m[1]).filter((e) => envRe.test(e))
    const textHit = re.test(text)
    for (const e of envs) (envMap.get(e) ?? envMap.set(e, new Set()).get(e)).add(d)
    if (d.startsWith('_')) { if (textHit && /_shared/.test(f)) shared.add(f.replace('supabase/functions/', '')) ; continue }
    const hostHit = [...text.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()).filter((h) => hostRe.test(h))
    hostHit.forEach((h) => hosts.add(h))
    if (nameHit || envs.length || hostHit.length) {
      fns.add(d)
      if (/webhook|callback|ingest|inbound/.test(d)) {
        const sig = [/createHmac|hmac/i.test(text) && 'HMAC', /constructEvent|stripe-signature/i.test(text) && 'Stripe signature', /x-twilio-signature/i.test(text) && 'Twilio signature', /svix/i.test(text) && 'Svix', /timingSafeEqual/i.test(text) && 'constant-time compare', /x-vapi-secret|VAPI_SERVER_SECRET/i.test(text) && 'shared-secret header', /state/i.test(text) && /oauth|callback/.test(d) && 'OAuth state'].filter(Boolean)
        webhooks.set(d, sig)
      }
      if (slug === 'stripe' && /webhook/.test(d)) for (const m of text.matchAll(STRIPE_EVENT)) events.add(m[1])
    }
  }
  const lib = libFiles.filter(([, t]) => re.test(t)).map(([f]) => f)
  if (!fns.size && !envMap.size) continue
  const refDocs = docs.filter(([, t]) => (t.match(new RegExp(re.source, 'gi')) ?? []).length >= 2).map(([f]) => f)
  const envRows = [...envMap].sort().map(([e, s]) => [e, [...s].sort()])
  const mode = envRows.map(([e]) => e).filter((e) => /SANDBOX|_ENV$|ENVIRONMENT|MODE|BASE_URL|HOST/.test(e))
  const fnList = [...fns].sort()
  const hookNames = [...webhooks.keys()].sort()
  let md = `# ${name}\n\n> Generated by \`npm run docs:providers\` from the source tree — do not edit by hand. Owner-maintained facts (dashboard, scopes, sandbox, rotation, DPA) go in [OWNER_REGISTER.md](OWNER_REGISTER.md).\n\n`
  md += `## Where it is used\n- Edge functions (${fnList.length}): ${code(fnList.slice(0, 40))}${fnList.length > 40 ? ` +${fnList.length - 40} more` : ''}\n- Shared modules: ${code([...shared].sort().slice(0, 12))}\n- Frontend modules in \`src/lib\` that mention it (${lib.length}): ${code(lib.slice(0, 10))}${lib.length > 10 ? ` +${lib.length - 10}` : ''}\n- Outbound API hosts seen in code: ${code([...hosts].sort())}\n\n`
  md += `## Secrets and configuration (set with \`supabase secrets set NAME=value\`)\n`
  md += envRows.length ? `| Name | Read by |\n|---|---|\n${envRows.map(([e, s]) => `| \`${e}\` | ${code(s.slice(0, 6))}${s.length > 6 ? ` +${s.length - 6}` : ''} |`).join('\n')}\n\n` : 'No provider-prefixed environment variables detected (the provider may use a shared key such as a user-supplied credential stored in the database).\n\n'
  if (mode.length) md += `Environment/sandbox switches detected by name: ${code(mode)} — confirm which values are production.\n\n`
  md += `## Inbound endpoints (webhooks / OAuth callbacks)\n`
  md += hookNames.length ? `Base URL: \`https://<project-ref>.supabase.co/functions/v1/<function>\`\n\n| Function | Signature / state evidence |\n|---|---|\n${hookNames.map((h) => `| \`${h}\` | ${webhooks.get(h).length ? webhooks.get(h).join(', ') : '**none detected — review**'} |`).join('\n')}\n\n` : 'None detected.\n\n'
  if (events.size) md += `Event types referenced by the Stripe webhook functions: ${code([...events].sort())}\n\n`
  md += `## Setup checklist\n1. Create the credentials in the provider's dashboard (production and, where offered, sandbox). Record scopes and owner in [OWNER_REGISTER.md](OWNER_REGISTER.md).\n`
  md += envRows.length ? `2. Set the secrets listed above in each environment (\`supabase secrets set …\`); never commit them. Inventory of every variable: [../../generated/ENV_USAGE.md](../../generated/ENV_USAGE.md).\n` : `2. Store the credential where the connect function expects it (see the functions above).\n`
  md += `3. Deploy the functions (\`supabase functions deploy <name>\`). Functions that authenticate themselves (webhooks, callbacks, public links) must be deployed with \`--no-verify-jwt\`; see [../../../RUNBOOK.md](../../../RUNBOOK.md) §2.3.\n`
  md += hookNames.length ? `4. Register each inbound URL above in the provider's dashboard, subscribe only to the events the function handles, and copy the signing secret into the matching secret name.\n5. Send a test event; confirm the function returns 2xx and the expected rows change. Rows without signature evidence above need a code review before going live.\n` : `4. Exercise the flow end to end in sandbox before enabling in production.\n`
  md += `\n## Operate\n- Rotation / leak response: [../../../RUNBOOK.md](../../../RUNBOOK.md) §7. Incident handling: §6.\n- Call-flow and function details: [../../functions/README.md](../../functions/README.md).\n- Existing hand-written docs that discuss this provider: ${code(refDocs.slice(0, 8))}\n`
  files.set(`${slug}.md`, md)
  summary.push({ name, slug, fns: fnList.length, env: envRows.length, hooks: hookNames.length, noSig: hookNames.filter((h) => !webhooks.get(h).length).length, docs: refDocs.length })
}
let idx = `# Provider setup guides\n\n> Generated by \`npm run docs:providers\`. One page per third-party provider found in code. Owner-maintained facts: [OWNER_REGISTER.md](OWNER_REGISTER.md).\n\n| Provider | Functions | Secrets | Inbound endpoints | …without signature evidence | Hand-written docs |\n|---|---:|---:|---:|---:|---:|\n`
for (const s of summary) idx += `| [${s.name}](${s.slug}.md) | ${s.fns} | ${s.env} | ${s.hooks} | ${s.noSig} | ${s.docs} |\n`
files.set('README.md', idx)

mkdirSync(OUT, { recursive: true })
let stale = 0
for (const [n, c] of files) {
  const p = join(OUT, n)
  if (CHECK) { if (!existsSync(p) || read(p) !== c) { console.error(`stale: ${p}`); stale++ } } else writeFileSync(p, c)
}
if (CHECK && stale) { console.error('Run: npm run docs:providers'); process.exit(1) }
console.log(CHECK ? 'fresh' : `wrote ${files.size} files (${summary.length} providers)`)
