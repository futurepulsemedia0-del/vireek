// Direct Bank Intelligence — pure matching + categorization engine.
// No I/O: everything here is deterministic and unit-testable.
// Amounts are signed integer cents (positive = money IN).

export type MatchType = "ar_invoice" | "ar_payment" | "ap_bill" | "ap_bill_payment" | "expense" | "income" | "transfer";

export interface Ref { id: string; amount_cents: number; label: string }
export interface Suggestion {
  match_type: MatchType | null;
  refs: Ref[];
  confidence: number;
  reason: string;
  category_code: string | null;
  category_label: string | null;
  category_confidence: number | null;
  category_source: "rule" | "ai" | "user" | null;
}
export interface BankTxn {
  id: string;
  posted_date: string; // YYYY-MM-DD
  amount_cents: number;
  description: string;
  merchant_name: string | null;
  account_type: string; // depository | credit | ...
}
export interface OpenDoc { id: string; number: string; party: string; balance_cents: number; date: string }
export interface BookedPayment { id: string; amount_cents: number; date: string; label: string }
export interface LearnedRule { merchant_key: string; category_code: string }
export interface EngineContext {
  invoices: OpenDoc[];
  bills: OpenDoc[];
  bookedAr: BookedPayment[];
  bookedAp: BookedPayment[];
  rules: Map<string, string>; // merchant_key -> category_code
  accountNames: Map<string, string>; // code -> name
  claimed: Set<string>; // refs already used by another suggestion in this run
}

export const HIGH_CONFIDENCE = 0.9;

// ---------- text helpers ----------
export function normalize(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}
export function merchantKey(merchant: string | null, description: string): string {
  const base = (merchant && merchant.trim()) || description;
  return base.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
}
const STOP = new Set(["inc", "llc", "ltd", "co", "corp", "company", "the", "and", "services", "service", "of", "ach", "credit", "debit", "payment", "pmt", "deposit", "online", "transfer"]);
function nameTokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length >= 3 && !STOP.has(t));
}
/** Fraction of the party's name tokens present in the bank text (0..1). */
export function nameOverlap(party: string, text: string): number {
  const pt = nameTokens(party);
  if (!pt.length) return 0;
  const bag = new Set(nameTokens(text));
  return pt.filter((t) => bag.has(t)).length / pt.length;
}
/** True when the document number appears as its own token sequence in the text. */
export function mentionsNumber(docNumber: string, text: string): boolean {
  const spaced = normalize(docNumber).trim();
  if (spaced.length < 3) return false;
  const hay = normalize(text);
  if (hay.includes(` ${spaced} `)) return true;
  const compact = spaced.replace(/ /g, "");
  return compact.length >= 4 && hay.split(" ").includes(compact);
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}
const clamp = (n: number, lo = 0, hi = 0.99) => Math.min(hi, Math.max(lo, n));
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------- subset sum (up to 2 solutions, node-capped) ----------
export function findSubsets(values: number[], target: number, maxItems: number, nodeCap = 200_000): number[][] {
  const idx = values.map((v, i) => i).filter((i) => values[i] > 0 && values[i] <= target).sort((a, b) => values[b] - values[a]);
  const suffix: number[] = new Array(idx.length + 1).fill(0);
  for (let i = idx.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + values[idx[i]];
  const out: number[][] = [];
  let nodes = 0;
  const pick: number[] = [];
  const dfs = (pos: number, remaining: number): void => {
    if (out.length >= 2 || nodes++ > nodeCap) return;
    if (remaining === 0) { out.push([...pick]); return; }
    if (pos >= idx.length || pick.length >= maxItems || suffix[pos] < remaining) return;
    const v = values[idx[pos]];
    if (v <= remaining) { pick.push(idx[pos]); dfs(pos + 1, remaining - v); pick.pop(); }
    dfs(pos + 1, remaining);
  };
  dfs(0, target);
  return out;
}

// ---------- categorization rules ----------
interface Rule { re: RegExp; code: string; label: string; conf: number }
const RULES: Rule[] = [
  { re: /payroll|gusto|\badp\b|paychex|rippling|justworks|trinet|zenefits|eftps|irs treas/i, code: "6000", label: "Payroll Expense", conf: 0.88 },
  { re: /shell|chevron|exxon|mobil|\bbp\b|sunoco|valero|circle k|wawa|speedway|pilot|love'?s|fuel|gas station|jiffy lube|autozone|o'?reilly|napa auto|discount tire|u-?haul|fleet/i, code: "6100", label: "Vehicle and Fuel Expense", conf: 0.9 },
  { re: /google ads|facebook|meta ads|fb ads|yelp|angi|homeadvisor|thumbtack|nextdoor|mailchimp|vistaprint|bing ads|tiktok ads|lsa/i, code: "6200", label: "Marketing and Advertising", conf: 0.9 },
  { re: /google workspace|gsuite|microsoft|msft|adobe|zoom|slack|dropbox|quickbooks|intuit|servicetitan|housecall|jobber|openai|anthropic|github|amazon web|\baws\b|twilio|supabase|vercel|notion|canva|zapier|godaddy|namecheap|apple\.com/i, code: "6300", label: "Software and Subscriptions", conf: 0.9 },
  { re: /insurance|geico|state farm|progressive|allstate|liberty mutual|nationwide|hartford|next insurance|hiscox|travelers/i, code: "6500", label: "Insurance", conf: 0.9 },
  { re: /\brent\b|lease|property mgmt|electric|power co|duke energy|con ?ed|pg&e|water dept|utilit|comcast|xfinity|spectrum|verizon|at&t|t-mobile|waste m/i, code: "6400", label: "Rent and Utilities", conf: 0.85 },
  { re: /home depot|lowe'?s|ferguson|grainger|supply ?house|johnstone|hvac supply|plumbing supply|electrical supply|graybar|winsupply|rexel|fastenal|harbor freight|menards|ace hardware|watsco|trane|lennox|carrier/i, code: "5000", label: "Cost of Goods Sold - Parts", conf: 0.9 },
  { re: /subcontract|1099|contractor pay/i, code: "5100", label: "Subcontractor Cost", conf: 0.8 },
  { re: /service fee|monthly fee|overdraft|wire fee|bank fee|maintenance fee|interest charge/i, code: "6900", label: "General and Administrative", conf: 0.85 },
];
const TRANSFER_RE = /\btransfer\b|xfer|payment to (credit )?card|credit card pay|autopay|payment thank|epayment|card payment/i;
const PROCESSOR_RE = /stripe|square|paypal|payout|clover|shopify|authorize\.?net/i;
const INFLOW_OTHER_RE = /refund|interest paid|interest earned|dividend|cashback|rebate/i;

export function categorizeByRules(txn: BankTxn, ctx: Pick<EngineContext, "rules" | "accountNames">): Pick<Suggestion, "category_code" | "category_label" | "category_confidence" | "category_source"> | null {
  const learned = ctx.rules.get(merchantKey(txn.merchant_name, txn.description));
  if (learned) return { category_code: learned, category_label: ctx.accountNames.get(learned) ?? learned, category_confidence: 0.95, category_source: "user" };
  if (txn.amount_cents >= 0) return null;
  const text = `${txn.merchant_name ?? ""} ${txn.description}`;
  for (const r of RULES) if (r.re.test(text)) return { category_code: r.code, category_label: r.label, category_confidence: r.conf, category_source: "rule" };
  return null;
}

// ---------- matching ----------
const empty = (reason = ""): Suggestion => ({ match_type: null, refs: [], confidence: 0, reason, category_code: null, category_label: null, category_confidence: null, category_source: null });

interface Scored { doc: OpenDoc; score: number; viaNumber: boolean; overlap: number }

function scoreDocs(docs: OpenDoc[], amountAbs: number, text: string, txnDate: string, claimed: Set<string>): Scored[] {
  const out: Scored[] = [];
  for (const d of docs) {
    if (claimed.has(d.id)) continue;
    const viaNumber = mentionsNumber(d.number, text);
    const overlap = d.party ? nameOverlap(d.party, text) : 0;
    const exact = d.balance_cents === amountAbs;
    const partial = amountAbs < d.balance_cents;
    if (!exact && !(viaNumber && partial)) continue;
    let s = exact ? 0.55 : 0.4;
    if (viaNumber) s += 0.4;
    s += overlap * 0.3;
    const gap = daysBetween(d.date, txnDate);
    if (gap >= -1 && gap <= 120) s += 0.05;
    out.push({ doc: d, score: s, viaNumber, overlap });
  }
  return out.sort((a, b) => b.score - a.score);
}

function matchDocs(kind: "ar" | "ap", docs: OpenDoc[], txn: BankTxn, text: string, claimed: Set<string>): Suggestion | null {
  const amt = Math.abs(txn.amount_cents);
  const noun = kind === "ar" ? "invoice" : "bill";
  const type: MatchType = kind === "ar" ? "ar_invoice" : "ap_bill";
  const scored = scoreDocs(docs, amt, text, txn.posted_date, claimed);
  if (scored.length) {
    const [best, second] = scored;
    let conf = best.score;
    const margin = second ? best.score - second.score : 1;
    if (margin < 0.15) conf = Math.min(conf, 0.6); // ambiguous: several candidates fit equally well
    const reasons = [best.doc.balance_cents === amt ? `exact balance of ${noun} ${best.doc.number}` : `partial payment toward ${noun} ${best.doc.number}`];
    if (best.viaNumber) reasons.push(`${noun} number found in bank text`);
    if (best.overlap >= 0.5) reasons.push(`${kind === "ar" ? "customer" : "vendor"} name matches`);
    if (margin < 0.15) reasons.push("other candidates fit equally well — review");
    return { ...empty(), match_type: type, refs: [{ id: best.doc.id, amount_cents: amt, label: `${best.doc.number}${best.doc.party ? ` · ${best.doc.party}` : ""}` }], confidence: round3(clamp(conf)), reason: reasons.join("; ") };
  }
  // Multi-document payment (one deposit paying several invoices / one withdrawal paying several bills)
  const pool = docs.filter((d) => !claimed.has(d.id) && d.balance_cents < amt);
  const attempt = (group: OpenDoc[], maxItems: number): OpenDoc[] | "ambiguous" | null => {
    if (group.length < 2) return null;
    const sols = findSubsets(group.map((d) => d.balance_cents), amt, maxItems);
    if (!sols.length) return null;
    return sols.length > 1 ? "ambiguous" : sols[0].map((i) => group[i]);
  };
  const parties = new Map<string, OpenDoc[]>();
  for (const d of pool) if (d.party && nameOverlap(d.party, text) >= 0.5) parties.set(d.party, [...(parties.get(d.party) ?? []), d]);
  for (const [party, group] of parties) {
    const r = attempt(group, 30);
    if (r && r !== "ambiguous") return multi(type, r, 0.9, `${r.length} ${noun}s of ${party} add up exactly to this amount`);
    if (r === "ambiguous") return { ...empty(), match_type: null, confidence: 0, reason: `Several ${noun} combinations of ${party} fit this amount — review manually` };
  }
  const r = attempt(pool.slice(0, 24), 6);
  if (r && r !== "ambiguous") return multi(type, r, 0.6, `${r.length} open ${noun}s add up exactly to this amount (no name match — verify)`);
  return null;
}
function multi(type: MatchType, docs: OpenDoc[], confidence: number, reason: string): Suggestion {
  return { ...empty(), match_type: type, refs: docs.map((d) => ({ id: d.id, amount_cents: d.balance_cents, label: `${d.number}${d.party ? ` · ${d.party}` : ""}` })), confidence, reason };
}

function matchBooked(kind: "ar" | "ap", booked: BookedPayment[], txn: BankTxn, processor: boolean, claimed: Set<string>): Suggestion | null {
  const amt = Math.abs(txn.amount_cents);
  const type: MatchType = kind === "ar" ? "ar_payment" : "ap_bill_payment";
  const pool = booked.filter((p) => !claimed.has(p.id) && Math.abs(daysBetween(p.date, txn.posted_date)) <= 10);
  const exact = pool.filter((p) => p.amount_cents === amt);
  if (exact.length) {
    const unique = exact.length === 1;
    return { ...empty(), match_type: type, refs: [{ id: exact[0].id, amount_cents: amt, label: exact[0].label }], confidence: unique ? 0.88 : 0.6, reason: unique ? "Already booked in your ledger — this bank line confirms it" : "Several booked payments share this amount — review" };
  }
  const sols = findSubsets(pool.slice(0, 40).map((p) => p.amount_cents), amt, 40);
  if (sols.length === 1) {
    const group = sols[0].map((i) => pool[i]);
    return { ...empty(), match_type: type, refs: group.map((p) => ({ id: p.id, amount_cents: p.amount_cents, label: p.label })), confidence: processor ? 0.9 : 0.65, reason: `${group.length} booked payments add up to this ${processor ? "processor payout" : "amount"}` };
  }
  return null;
}

export function suggest(txn: BankTxn, ctx: EngineContext): Suggestion {
  const text = `${txn.merchant_name ?? ""} ${txn.description}`;
  const inflow = txn.amount_cents > 0;
  const depository = txn.account_type === "depository";
  const processor = PROCESSOR_RE.test(text);

  if (TRANSFER_RE.test(text) && !processor) return { ...empty("Looks like a transfer between your own accounts"), match_type: "transfer", confidence: 0.75 };

  const primary = (): Suggestion | null => {
    if (inflow && depository) {
      const booked = () => matchBooked("ar", ctx.bookedAr, txn, processor, ctx.claimed);
      const docs = () => matchDocs("ar", ctx.invoices, txn, text, ctx.claimed);
      return processor ? booked() ?? docs() : docs() ?? booked();
    }
    if (!inflow) {
      return matchDocs("ap", ctx.bills, txn, text, ctx.claimed) ?? matchBooked("ap", ctx.bookedAp, txn, false, ctx.claimed);
    }
    return null;
  };
  const m = primary();
  if (m && (m.match_type || m.reason)) {
    const cat = !m.match_type ? categorizeByRules(txn, ctx) : null;
    return { ...m, ...(cat ?? {}) };
  }

  const cat = categorizeByRules(txn, ctx);
  if (!inflow && cat) return { ...empty(`Categorized as ${cat.category_label}`), match_type: "expense", confidence: cat.category_confidence ?? 0, ...cat };
  if (inflow && INFLOW_OTHER_RE.test(text)) return { ...empty("Looks like non-invoice income (refund/interest)"), match_type: "income", confidence: 0.6, category_code: "4900", category_label: "Other Income", category_confidence: 0.6, category_source: "rule" };
  if (inflow) return empty(processor ? "Processor payout — no booked payments add up to this amount" : "Deposit with no matching open invoice");
  return empty("Needs a category");
}

export function claimRefs(s: Suggestion, claimed: Set<string>): void {
  if (s.match_type === "ar_invoice" || s.match_type === "ap_bill" || s.match_type === "ar_payment" || s.match_type === "ap_bill_payment") for (const r of s.refs) claimed.add(r.id);
}

/** Greedy conflict-free assignment: highest-confidence suggestions claim documents first. */
export function suggestAll(txns: BankTxn[], base: Omit<EngineContext, "claimed">): Map<string, Suggestion> {
  const first = txns.map((t) => ({ t, s: suggest(t, { ...base, claimed: new Set() }) }));
  first.sort((a, b) => b.s.confidence - a.s.confidence || a.t.id.localeCompare(b.t.id));
  const claimed = new Set<string>();
  const result = new Map<string, Suggestion>();
  for (const { t, s } of first) {
    const clash = s.refs.some((r) => claimed.has(r.id));
    const final = clash ? suggest(t, { ...base, claimed }) : s;
    claimRefs(final, claimed);
    result.set(t.id, final);
  }
  return result;
}

export { fmt as formatCents };
