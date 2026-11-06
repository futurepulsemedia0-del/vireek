#!/usr/bin/env node
// scripts/gen-function-reference.mjs
//
// Generates docs/functions/<domain>.md + docs/functions/README.md: one row per edge function with the
// purpose (from its header comment), auth evidence, HTTP methods, tables / RPCs touched, functions it
// invokes, external hosts, secrets read, and the docs that mention it. Static regex scan: every column
// states what the source text contains, nothing more. Plain Node, no dependencies.
//
// Usage:  npm run docs:functions
//         npm run docs:functions -- --check     exit 1 if committed files are stale

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CHECK = process.argv.includes('--check')
const FN = 'supabase/functions'
const OUT = 'docs/functions'
const read = (p) => readFileSync(p, 'utf8')
const walk = (d) =>
  !existsSync(d) ? [] : readdirSync(d).flatMap((n) => {
    const p = join(d, n)
    return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : [p]
  })
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
const list = (xs, max = 8) => (xs.length ? xs.slice(0, max).map((x) => `\`${esc(x)}\``).join(', ') + (xs.length > max ? ` +${xs.length - max}` : '') : '—')

// Ordered: first match wins.
const DOMAINS = [
  ['security-trust-compliance', 'Security, trust & compliance', /^(security-|trust|siem|scim|admin-sso|mfa-|trusted-device|check-ip|delete-account|homeowner-delete|dsar|data-retention|audit-|compliance|subprocessor|login-alert|staff-impersonate|slo-|synthetic|dr-|ai-disclosure|verification-network|identity-signal|conversation-intel-purge|quote-video-retention|feedback-retention|evidence-marketplace|exit-dataroom|findings-package)/],
  ['payments-billing', 'Payments & billing', /^(stripe|pay|payment|public-payment|invoice|issue-refund|instant-payouts|create-(payment|checkout|billing)|billing|manage-subscription|membership|financing|terminal|split-payment|statements|franchise-royalty|commercial-collections|sla-credit|enforce-payment|capital|cash-flow|lien-waiver|dispute|tax-|send-payment|phone-payment|revenue-realization|money-recovered)/],
  ['accounting-payroll-banking', 'Accounting, payroll & banking', /^(acct|qbo|xero|intacct|ns-|payroll|bank|price-book|supplier|expense|fx-|punchout)/],
  ['voice-telephony-messaging', 'Voice, telephony & messaging', /^(voice|vapi|call|dialer|pbx|interpreter|first-call|live-|csr-|clone|sms|whatsapp|messenger|telegram|rich-|dm-|speed-to-lead|register-a2p|proxy-call|outbound|shadow|auto-reply|ovb|escalation|escalate|emergency|resend-events|notification-router|deferred-message)/],
  ['chat-email-marketing', 'Chat, email, notifications & marketing', /^(chat-|email|send-|notify|notification|push|marketing|direct-mail|survey|unsubscribe|feedback|reputation|review|blog|cadence|comment|contact-sales|lifecycle|followup|pm-notify|mutual-aid|status-feed|geo-grid|gbp|demo-chat|site-assistant|ads-|listings)/],
  ['integrations-oauth', 'Integrations & OAuth connectors', /(oauth|^hubspot|^jobber|^crm-|^google|^microsoft|landing-domain|verify-custom-domain|^telematics-connect|^job-feeds|^lead-marketplace|^third-party|^whatsapp-connect|^bank-connect|^intacct-connect)/],
  ['scheduling-dispatch-field', 'Scheduling, dispatch & field operations', /^(dispatch|job|automation|arrival|booking|calendar|optimize-route|recurring|technician|telematics|fleet|compute-fleet|wallet|warranty|check-warranty|detect-warranty|closeout|permit|quote|estimate|inspection|sign-document|field-|daily-log|diagnosis|adaptive|equipment|capacity|backfill|rescue|weather|service-|detect-service|remote-resolution|video-ice|visual-estimate|takeoff|no-surprise|homeowner|portal-home|property|home-health|energy|rebate|predictive|rr-device|iot|leak-report|check-contract|check-credential|check-margin|commitment|check-usage|check-warranty|state-of-calls|survey)/],
  ['platform-data-api', 'Platform, data & public API', /^(api-v1|mcp-server|agent|data-|bi-|export|metrics|analytics|event-bus|fabric|rum|status|browser-extension|workflow|playbook|self-healing|public|insights-api|scheduled-reports|executive-report|value-scoreboard|statements-run|careers|knowledge|kce|rich|consumer-agent|operator|ask-vireek|ai-assistant|ai-eval|interpreter)/],
  ['ai-intelligence', 'AI & business intelligence', /^(ai-|analyze|causal|business|compute|insights|generate|mine-|goal|incentive|vertical-ai|flywheel|failure-genome|operational|opportunity|outcome|next-best|detect|workforce|staffing|talent|tribal|telemetry|conversation-intel|contract-intelligence|cash|executive|job-context|job-summary|temporal|operator|external-world|regional|capacity-demand|onboarding|daily-briefing|bank-i|bank-intel|dispatch-copilot|live-copilot|knowledge|adaptive|home|science|field-scientist|business-scientist|simulator|hypothes)/],
]
const domainOf = (n) => DOMAINS.find(([, , re]) => re.test(n)) ?? ['other', 'Other / uncategorised', null]

function purposeOf(src) {
  const lines = src.split('\n').slice(0, 40)
  const out = []
  let inBlock = false
  for (const raw of lines) {
    const l = raw.trim()
    if (inBlock) {
      if (l.includes('*/')) { inBlock = false; break }
      out.push(l.replace(/^\*+\s?/, ''))
      continue
    }
    if (/^\/\*/.test(l)) { inBlock = true; out.push(l.replace(/^\/\*+\s?/, '').replace(/\*\/.*/, '')); if (/\*\//.test(l)) break; continue }
    if (/^\/\//.test(l)) { out.push(l.replace(/^\/\/+\s?/, '')); continue }
    if (/^(#!|import |export |const |let |Deno\.|\/\/ @ts)/.test(l)) { if (out.length) break; continue }
    if (!l && out.length) break
  }
  const text = out
    .map((s) => s.trim())
    .filter((s) => s && !/^[-=*_#\s]{3,}$/.test(s) && !/^(supabase\/functions\/|functions\/)[\w-]+/.test(s) && !/^@ts-/.test(s) && !/^deno-lint/.test(s))
  if (!text.length) return ''
  let first = text.join(' ').replace(/\s+/g, ' ')
  first = first.replace(/^[\w-]+\s*[—–-]\s+/, (m) => m) // keep "name — purpose"
  const cut = first.match(/^(.{20,200}?[.!?])(\s|$)/)
  return (cut ? cut[1] : first.slice(0, 200)).trim()
}
function stripName(p, n) {
  return p.replace(new RegExp('^' + n.replace(/[-]/g, '[-]') + '\\s*[—–-]\\s*', 'i'), '')
}

const docs = ['README.md', 'ARCHITECTURE.md', 'RUNBOOK.md', 'ENVIRONMENT.md', 'VOICE_RUNBOOK.md', 'XERO_SYNC.md', ...walk('docs').filter((f) => f.endsWith('.md') && !/^docs\/(generated|functions|integrations\/providers)\//.test(f) && !/function-matrix/.test(f))].filter(existsSync)
const docText = docs.map((d) => [d, read(d)])

const names = readdirSync(FN).filter((n) => !n.startsWith('_') && statSync(join(FN, n)).isDirectory())
const names2 = new Set(names)
const rows = []
for (const n of names) {
  const idx = join(FN, n, 'index.ts')
  if (!existsSync(idx)) { rows.push({ n, nofile: true, dom: domainOf(n) }); continue }
  const src = read(idx)
  const tables = [...new Set([...src.matchAll(/\.from\(\s*['"`]([a-z0-9_]+)['"`]\s*\)/g)].map((m) => m[1]))].sort()
  const rpcs = [...new Set([...src.matchAll(/\.rpc\(\s*['"`]([a-z0-9_]+)['"`]/g)].map((m) => m[1]))].sort()
  const invokes = [...new Set([...src.matchAll(/functions\.invoke\(\s*['"`]([a-z0-9-]+)['"`]|\/functions\/v1\/([a-z0-9-]+)/g)].map((m) => m[1] ?? m[2]))].filter((x) => x && x !== n).sort()
  const hosts = [...new Set([...src.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()))].filter((h) => !/supabase\.(co|in)$|vireek\.com$|w3\.org$|schema\.org$|example\.com$|deno\.land$|esm\.sh$|jsr\.io$|npmjs\.org$/.test(h)).sort()
  const env = [...new Set([...src.matchAll(/Deno\.env\.get\(\s*['"]([A-Z0-9_]+)['"]/g)].map((m) => m[1]))].filter((e) => !/^SUPABASE_/.test(e)).sort()
  const methods = [...new Set([...src.matchAll(/req\.method\s*[!=]==?\s*['"]([A-Z]+)['"]/g)].map((m) => m[1]))].filter((m) => m !== 'OPTIONS').sort()
  const auth = [
    /\.getUser\(|headers\.get\(\s*['"]authorization['"]\s*\)/i.test(src) && 'user JWT',
    /CRON_SECRET|x-cron-secret/i.test(src) && 'cron secret',
    /x-api-key|verifyApiKey|hashApiKey|authenticateApiKey|from\(\s*['"]api_keys['"]/i.test(src) && 'API key',
    /createHmac|hmac|timingSafeEqual|constructEvent|stripe-signature|x-twilio-signature|svix|x-hub-signature|verifySignature/i.test(src) && 'signature',
    /x-[a-z-]*secret|[A-Z_]*SERVER_SECRET/i.test(src) && 'shared-secret header',
    /is_vireek_staff|isVireekStaff|requireStaff|assertStaff/i.test(src) && 'staff check',
    /state=|oauth_state|OAUTH_STATE/i.test(src) && 'OAuth state',
    /service_role|SERVICE_ROLE/i.test(src) && 'service-role client',
  ].filter(Boolean)
  const shared = [...new Set([...src.matchAll(/from\s+['"]\.\.\/_shared\/([^'"]+)['"]/g)].map((m) => m[1].replace(/\.ts$/, '')))].sort()
  const docRefs = docText.filter(([, t]) => t.includes(n)).map(([d]) => d)
  rows.push({ n, purpose: stripName(purposeOf(src), n), tables, rpcs, invokes: invokes.filter((x) => names2.has(x)), hosts, env, methods, auth, shared, lines: src.split('\n').length, docRefs, dom: domainOf(n) })
}

const by = {}
for (const r of rows) (by[r.dom[0]] ??= { title: r.dom[1], rows: [] }).rows.push(r)
const files = new Map()
const hdr = (t, extra) => `# ${t}\n\n> Generated by \`npm run docs:functions\` — do not edit by hand.\n> ${extra}\n\n`
for (const [slug, g] of Object.entries(by)) {
  g.rows.sort((a, b) => a.n.localeCompare(b.n))
  let md = hdr(`Edge functions — ${g.title}`, 'Source: supabase/functions/<name>/index.ts. "Purpose" is the first sentence of the file\'s header comment. Columns are regex detections of what the source contains; they are not an auth review (see docs/security/function-matrix.md).') +
    `${g.rows.length} functions.\n\n| Function | Purpose | Auth evidence | Methods | Tables | RPCs | Invokes | External hosts | Secrets read | Docs |\n|---|---|---|---|---|---|---|---|---|---|\n`
  for (const r of g.rows) {
    if (r.nofile) { md += `| \`${r.n}\` | _no index.ts in this folder_ | — | — | — | — | — | — | — | — |\n`; continue }
    md += `| \`${r.n}\` | ${r.purpose ? esc(r.purpose) : '_no header comment_'} | ${r.auth.length ? r.auth.join(', ') : 'none detected'} | ${r.methods.join(', ') || '—'} | ${list(r.tables)} | ${list(r.rpcs, 5)} | ${list(r.invokes, 4)} | ${list(r.hosts, 4)} | ${list(r.env, 6)} | ${r.docRefs.length ? list(r.docRefs, 2) : '—'} |\n`
  }
  files.set(`${slug}.md`, md)
}
const noPurpose = rows.filter((r) => !r.nofile && !r.purpose).length
const noDoc = rows.filter((r) => !r.nofile && !r.docRefs.length).length
let idx = hdr('Edge function reference', 'Index of per-domain reference tables.') +
  `Total: **${rows.length}** functions · without a header-comment purpose: **${noPurpose}** · not named in any hand-written doc: **${noDoc}**.\n\n| Domain | Functions |\n|---|---:|\n`
for (const [slug, g] of Object.entries(by).sort((a, b) => a[1].title.localeCompare(b[1].title))) idx += `| [${g.title}](${slug}.md) | ${g.rows.length} |\n`
idx += '\nAdd a header comment to a function (purpose, auth model, inputs/outputs) and re-run `npm run docs:functions` to improve its row. Flat inventory with auth/verify_jwt: [`../generated/EDGE_FUNCTIONS.md`](../generated/EDGE_FUNCTIONS.md).\n'
files.set('README.md', idx)

mkdirSync(OUT, { recursive: true })
let stale = 0
for (const [name, content] of files) {
  const p = join(OUT, name)
  if (CHECK) { if (!existsSync(p) || read(p) !== content) { console.error(`stale: ${p}`); stale++ } }
  else { writeFileSync(p, content) }
}
if (CHECK && stale) { console.error('Run: npm run docs:functions'); process.exit(1) }
console.log(CHECK ? 'fresh' : `wrote ${files.size} files; no-purpose=${noPurpose}; no-doc=${noDoc}`)
