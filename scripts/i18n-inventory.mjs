#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  i18n surface inventory (Phase 0, read-only)                         */
/*                                                                      */
/*    node scripts/i18n-inventory.mjs            markdown to stdout     */
/*    node scripts/i18n-inventory.mjs --json     machine-readable       */
/*                                                                      */
/*  AST-based (TypeScript parser). Counts hard-coded user-facing text   */
/*  per SURFACE tier (S1..S6). Surface assignment is a PATH HEURISTIC   */
/*  (see classify()); review the mapping before relying on it for CI.   */
/*  Counts: JSX text, copy-like attributes (placeholder/title/aria-     */
/*  label/alt/label), toast()/message-style calls, and (for edge        */
/*  functions) string literals of 3+ words inside template-ish files.   */
/* ------------------------------------------------------------------ */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const json = process.argv.includes('--json');
const ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt', 'label', 'aria-description', 'description']);
const letters = (s) => /[A-Za-z]{2,}/.test(s);
const copyLike = (s) => letters(s) && !/^[\w./:#@\-${}]+$/.test(s.trim());
const words3 = (s) => s.trim().split(/\s+/).length >= 3 && /[A-Za-z]{3,}/.test(s);

function* walk(p, exts, skip = []) {
  if (!fs.existsSync(p)) return;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const f = path.join(p, e.name);
    if (skip.some((s) => f.includes(s))) continue;
    if (e.isDirectory()) yield* walk(f, exts, skip);
    else if (exts.some((x) => f.endsWith(x)) && !/\.(test|spec)\./.test(f)) yield f;
  }
}

const R = {
  legal: /(Terms|Privacy|AcceptableUse|SmsTerms|SmsCompliance|AiDisclosure|AiTransparency|LocationPrivacy|AccessibilityStatement|AccessibilityConformance|CookieConsent|Dpa|Subprocessor|Sla|Consent|Compliance)/,
  s1: /(Portal|Booking|QuoteAccept|ReviewSubmit|Tracking|Unsubscribe|SmsTextBack|PublicTechnician|PayByPhone|PayInvoice|CustomerStatements|SupplierPortal|EmergencyTriage)/,
  tech: /(^|\/)(Tech[A-Z]|Technician|FieldMessages|FieldEvidence|HiddenTechnician)/,
  auth: /(Login|Signup|SsoLogin|Onboarding|Billing|Password|Mfa|Passkey|InviteAccept|VerifyEmail|PaymentFailed|Plans)/,
  docs: /(Blog|Help|DeveloperDocs|ApiReference|Academy|Docs|Changelog|StatusPage|Glossary|Guide)/,
  mkt: /(Landing|PricingPage|About|Alternative|VsPage|Vs[A-Z]|CustomerStories|Industry|Solutions|Features|Compare|Ambassador|Affiliate|BetaProgram|Careers|BrandGuidelines|Header|Footer|Press|Partners?Page|Wallet)/,
  core: /(DashboardPage|HomePage|CustomersPage|CustomerDetail|JobsPage|JobDetail|SchedulePage|Dispatch|CallsPage|CallDetail|Inbox|QuotesPage|QuoteDetail|InvoicesPage|InvoiceDetail|SettingsPage|AccountPage|TeamPage|ReviewsPage|MessagesPage|DashboardNav|NotificationBell|CommandPalette)/,
};
function classify(f) {
  if (f.startsWith('supabase/functions')) return 'S1-edge';
  if (R.legal.test(f)) return 'S1-legal';
  if (R.s1.test(f)) return 'S1-customer';
  if (R.tech.test(f)) return 'S2-tech';
  if (R.auth.test(f)) return 'S2-auth-billing';
  if (R.docs.test(f)) return 'S6-docs';
  if (R.mkt.test(f)) return 'S5-marketing';
  if (R.core.test(f)) return 'S3-core';
  return 'S4-longtail';
}

function scan(file, edge) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let n = 0;
  const hasT = /useTranslation|\bi18n\.t\(|\bt\(['"`]/.test(src);
  const visit = (x) => {
    if (!edge) {
      if (ts.isJsxText(x)) { const t = x.getText(); if (letters(t) && !/^\s*[{}&;·•|—–-]+\s*$/.test(t)) n++; }
      else if (ts.isJsxAttribute(x) && ATTRS.has(x.name.getText()) && x.initializer && ts.isStringLiteral(x.initializer) && copyLike(x.initializer.text)) n++;
      else if (ts.isCallExpression(x) && /^(toast(\.\w+)?|message\.\w+|alert)$/.test(x.expression.getText()) && x.arguments[0]) {
        const a = x.arguments[0]; if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) || ts.isTemplateExpression(a)) n++;
      }
    } else if ((ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) && words3(x.text) && !/^(import|export)/.test(x.parent?.getText?.().slice(0, 6) ?? '') && !ts.isImportDeclaration(x.parent) && !/^[A-Z_ ]+$/.test(x.text) && !/(SELECT|INSERT|FROM |https?:|Bearer|application\/|SUPABASE_)/.test(x.text)) n++;
    ts.forEachChild(x, visit);
  };
  visit(sf);
  return { n, hasT };
}

const out = {};
const add = (k, file, r) => {
  const o = (out[k] ??= { files: 0, filesWithFindings: 0, strings: 0, filesUsingI18n: 0 });
  o.files++; o.strings += r.n; if (r.n) o.filesWithFindings++; if (r.hasT) o.filesUsingI18n++;
};
for (const f of walk('src', ['.tsx'], ['src/test/', '__tests__'])) add(classify(f), f, scan(f, false));
// Edge functions: only files that look like outbound templates (sms/email/reminder/notify/review/quote/invoice/pdf)
const EDGE = /(sms|email|mail|reminder|review|notify|notification|quote|invoice|pdf|receipt|confirm|followup|follow-up|text-back|portal|booking|voice|call)/i;
const edgeFiles = [...walk('supabase/functions', ['.ts'])].filter((f) => EDGE.test(f));
for (const f of edgeFiles) add('S1-edge(templatey-files)', f, scan(f, true));

const tot = Object.values(out).reduce((a, o) => ({ files: a.files + o.files, strings: a.strings + o.strings }), { files: 0, strings: 0 });
if (json) { console.log(JSON.stringify({ out, tot }, null, 2)); process.exit(0); }
console.log('| Surface | Files | Files w/ hardcoded text | Hardcoded strings (AST) | Files using i18n |');
console.log('|---|---:|---:|---:|---:|');
for (const k of Object.keys(out).sort()) { const o = out[k]; console.log(`| ${k} | ${o.files} | ${o.filesWithFindings} | ${o.strings} | ${o.filesUsingI18n} |`); }
console.log(`| **Total** | ${tot.files} | | ${tot.strings} | |`);
