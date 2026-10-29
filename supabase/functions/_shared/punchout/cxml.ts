// cXML 1.2 PunchOut helpers — pure TypeScript, no Deno or Node APIs, so the same file runs in the edge
// functions and in vitest (src/lib/punchoutCxml.test.ts).
//
// Security notes
//  - The XML reader is deliberately tiny: it never expands custom entities, never fetches a DTD and
//    rejects any <!ENTITY declaration (no XXE / billion-laughs). Size, depth and node count are capped.
//  - assertSafeSupplierUrl() blocks non-HTTPS, credentials in URLs, IP literals, localhost and internal
//    host names, so a tenant cannot point the server-side request at our own network.

// ------------------------------------------------------------------ XML reader

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const MAX_XML_BYTES = 1_000_000;
const MAX_DEPTH = 40;
const MAX_NODES = 20_000;

export class CxmlError extends Error {}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!Number.isFinite(code) || code < 0x20 && code !== 9 && code !== 10 && code !== 13 || code > 0x10ffff) return "";
    try {
      return String.fromCodePoint(code);
    } catch {
      return m;
    }
  });
}

const localName = (n: string) => (n.includes(":") && !n.startsWith("xml:") ? n.slice(n.indexOf(":") + 1) : n);

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out[localName(m[1])] = decodeEntities(m[3] ?? m[4] ?? "");
  return out;
}

export function parseXml(input: string): XmlNode {
  if (typeof input !== "string" || input.length === 0) throw new CxmlError("Empty XML");
  if (input.length > MAX_XML_BYTES) throw new CxmlError("XML too large");
  if (/<!ENTITY/i.test(input)) throw new CxmlError("Entity declarations are not allowed");

  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  let nodes = 0;
  const n = input.length;

  while (i < n) {
    const lt = input.indexOf("<", i);
    const top = stack[stack.length - 1];
    if (lt === -1) {
      top.text += decodeEntities(input.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(input.slice(i, lt));

    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      if (end === -1) throw new CxmlError("Unterminated comment");
      i = end + 3;
    } else if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9);
      if (end === -1) throw new CxmlError("Unterminated CDATA");
      top.text += input.slice(lt + 9, end);
      i = end + 3;
    } else if (input.startsWith("<?", lt)) {
      const end = input.indexOf("?>", lt + 2);
      if (end === -1) throw new CxmlError("Unterminated processing instruction");
      i = end + 2;
    } else if (input.startsWith("<!", lt)) {
      // DOCTYPE: skip it (including an internal subset in [...]); never interpreted.
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        const ch = input[j];
        if (ch === "[") depth++;
        else if (ch === "]") depth--;
        else if (ch === ">" && depth <= 0) break;
      }
      if (j >= n) throw new CxmlError("Unterminated declaration");
      i = j + 1;
    } else if (input[lt + 1] === "/") {
      const end = input.indexOf(">", lt + 2);
      if (end === -1) throw new CxmlError("Unterminated closing tag");
      const name = localName(input.slice(lt + 2, end).trim());
      if (stack.length <= 1 || stack[stack.length - 1].name !== name) throw new CxmlError(`Mismatched closing tag </${name}>`);
      stack.pop();
      i = end + 1;
    } else {
      // Start tag — find the closing '>' while respecting quoted attribute values.
      let j = lt + 1;
      let quote = "";
      for (; j < n; j++) {
        const ch = input[j];
        if (quote) {
          if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ">") break;
      }
      if (j >= n) throw new CxmlError("Unterminated tag");
      let body = input.slice(lt + 1, j);
      const selfClose = body.endsWith("/");
      if (selfClose) body = body.slice(0, -1);
      const sp = body.search(/\s/);
      const rawName = (sp === -1 ? body : body.slice(0, sp)).trim();
      if (!rawName || !/^[A-Za-z_][\w:.-]*$/.test(rawName)) throw new CxmlError("Invalid tag name");
      if (++nodes > MAX_NODES) throw new CxmlError("XML has too many elements");
      const node: XmlNode = { name: localName(rawName), attrs: sp === -1 ? {} : parseAttrs(body.slice(sp)), children: [], text: "" };
      top.children.push(node);
      if (!selfClose) {
        if (stack.length > MAX_DEPTH) throw new CxmlError("XML is nested too deeply");
        stack.push(node);
      }
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new CxmlError("Unclosed element");
  const el = root.children[0];
  if (!el || root.children.length !== 1) throw new CxmlError("XML must have exactly one root element");
  return el;
}

export function child(node: XmlNode | undefined | null, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}
export function childAll(node: XmlNode | undefined | null, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}
export function path(node: XmlNode | undefined | null, ...names: string[]): XmlNode | undefined {
  let cur = node ?? undefined;
  for (const n of names) cur = child(cur, n);
  return cur;
}
export const textOf = (node: XmlNode | undefined | null): string => (node ? node.text.trim() : "");

// ------------------------------------------------------------------ money / strings

/** "12.5" -> 1250, "1,234.567" -> 123457 (half-up). Returns null for anything that is not a clean non-negative decimal. */
export function decimalToCents(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/,/g, "");
  const m = /^(\d{1,10})(?:\.(\d{1,8}))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = (m[2] ?? "").padEnd(3, "0");
  let cents = whole * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  return Number.isSafeInteger(cents) ? cents : null;
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c] as string));
}

const UOM: Record<string, string> = { EA: "each", BX: "box", CS: "case", PK: "pack", FT: "ft", LF: "ft", RL: "roll", PR: "pair", GAL: "gal", LB: "lb", SET: "set", KT: "kit", DZ: "dozen", BG: "bag", CT: "carton", PC: "each", ST: "set" };
export function mapUom(raw: string | null | undefined): string {
  const u = String(raw ?? "").trim();
  if (!u) return "each";
  return (UOM[u.toUpperCase()] ?? u.toLowerCase()).slice(0, 20);
}

// ------------------------------------------------------------------ SSRF guard

/** Returns the normalized URL or throws CxmlError. HTTPS only, default port, no credentials, no internal hosts. */
export function assertSafeSupplierUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new CxmlError("Enter a valid https:// URL");
  }
  if (u.protocol !== "https:") throw new CxmlError("The PunchOut URL must start with https://");
  if (u.username || u.password) throw new CxmlError("Do not put credentials in the URL");
  if (u.port && u.port !== "443") throw new CxmlError("Custom ports are not allowed");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^[\d.]+$/.test(host) || /^0x/i.test(host)) {
    throw new CxmlError("Use the supplier's host name, not an IP address");
  }
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(host) || host.endsWith(".supabase.co") || host.endsWith(".supabase.in")) {
    throw new CxmlError("That host is not allowed");
  }
  return u.toString();
}

// ------------------------------------------------------------------ build requests

export interface SetupRequestOptions {
  payloadId: string;
  timestamp: string; // ISO 8601 with offset
  buyer: { domain: string; identity: string };
  sender: { domain: string; identity: string; sharedSecret: string; userAgent: string };
  supplier: { domain: string; identity: string };
  buyerCookie: string;
  returnUrl: string;
  deploymentMode: "test" | "production";
  userEmail?: string | null;
  userName?: string | null;
}

export function buildSetupRequest(o: SetupRequestOptions): string {
  const cred = (c: { domain: string; identity: string }, secret?: string) =>
    `<Credential domain="${escapeXml(c.domain)}"><Identity>${escapeXml(c.identity)}</Identity>${secret ? `<SharedSecret>${escapeXml(secret)}</SharedSecret>` : ""}</Credential>`;
  const extr = (name: string, v?: string | null) => (v ? `<Extrinsic name="${name}">${escapeXml(v)}</Extrinsic>` : "");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE cXML SYSTEM "http://xml.cXML.org/schemas/cXML/1.2.014/cXML.dtd">`,
    `<cXML payloadID="${escapeXml(o.payloadId)}" timestamp="${escapeXml(o.timestamp)}">`,
    `<Header><From>${cred(o.buyer)}</From><To>${cred(o.supplier)}</To>`,
    `<Sender>${cred(o.sender, o.sender.sharedSecret)}<UserAgent>${escapeXml(o.sender.userAgent)}</UserAgent></Sender></Header>`,
    `<Request deploymentMode="${o.deploymentMode}"><PunchOutSetupRequest operation="create">`,
    `<BuyerCookie>${escapeXml(o.buyerCookie)}</BuyerCookie>`,
    extr("UserEmail", o.userEmail),
    extr("UserPrintableName", o.userName),
    `<BrowserFormPost><URL>${escapeXml(o.returnUrl)}</URL></BrowserFormPost>`,
    `</PunchOutSetupRequest></Request></cXML>`,
  ].join("");
}

// ------------------------------------------------------------------ parse responses

export interface SetupResponse {
  ok: boolean;
  code: number;
  text: string;
  startUrl: string | null;
}

export function parseSetupResponse(xml: string): SetupResponse {
  const root = parseXml(xml);
  if (root.name !== "cXML") throw new CxmlError("Not a cXML document");
  const resp = child(root, "Response");
  const status = child(resp, "Status");
  if (!resp || !status) throw new CxmlError("No Response/Status in the supplier's reply");
  const code = Number(status.attrs.code ?? 0);
  const text = (status.attrs.text ?? textOf(status) ?? "").slice(0, 200);
  const start = textOf(path(resp, "PunchOutSetupResponse", "StartPage", "URL"));
  let startUrl: string | null = null;
  if (start) {
    try {
      const u = new URL(start);
      if (u.protocol === "https:") startUrl = u.toString();
    } catch {
      startUrl = null;
    }
  }
  const ok = code >= 200 && code < 300 && startUrl !== null;
  return { ok, code, text, startUrl };
}

export interface CartLine {
  line_no: number;
  sku: string;
  aux_id: string | null;
  name: string;
  description: string | null;
  mpn: string | null;
  manufacturer: string | null;
  uom: string;
  quantity: number;
  unit_price_cents: number;
  lead_time_days: number | null;
  classification: string | null;
}

export interface OrderMessage {
  buyerCookie: string;
  currency: string;
  totalCents: number | null;
  lines: CartLine[];
}

const cut = (s: string, n: number) => (s ? s.slice(0, n) : null);

/** Parses a PunchOutOrderMessage. Throws CxmlError with a short, user-safe reason on anything malformed. */
export function parseOrderMessage(xml: string): OrderMessage {
  const root = parseXml(xml);
  if (root.name !== "cXML") throw new CxmlError("Not a cXML document");
  const msg = path(root, "Message", "PunchOutOrderMessage");
  if (!msg) throw new CxmlError("No PunchOutOrderMessage found");
  const buyerCookie = textOf(child(msg, "BuyerCookie"));
  if (!buyerCookie || buyerCookie.length > 200) throw new CxmlError("Missing BuyerCookie");

  const total = path(msg, "PunchOutOrderMessageHeader", "Total", "Money");
  const headerCurrency = (total?.attrs.currency ?? "").toUpperCase();
  const totalCents = total ? decimalToCents(textOf(total)) : null;

  const items = childAll(msg, "ItemIn");
  if (items.length === 0) throw new CxmlError("The cart is empty");
  if (items.length > 500) throw new CxmlError("The cart has too many lines");

  let currency = headerCurrency;
  const merged = new Map<string, CartLine>();
  for (const it of items) {
    const qtyRaw = (it.attrs.quantity ?? "").trim();
    if (!/^\d{1,6}(\.0+)?$/.test(qtyRaw)) throw new CxmlError("A line has a non-whole or invalid quantity");
    const quantity = parseInt(qtyRaw, 10);
    if (quantity < 1 || quantity > 100000) throw new CxmlError("A line has an invalid quantity");

    const sku = textOf(path(it, "ItemID", "SupplierPartID"));
    if (!sku || sku.length > 80) throw new CxmlError("A line has a missing or too-long part number");
    const detail = child(it, "ItemDetail");
    const money = path(detail, "UnitPrice", "Money");
    const cents = money ? decimalToCents(textOf(money)) : null;
    if (cents === null || cents > 100_000_000) throw new CxmlError(`Line ${sku} has an invalid unit price`);
    const lineCurrency = (money?.attrs.currency ?? "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(lineCurrency)) throw new CxmlError(`Line ${sku} has no currency`);
    if (currency && lineCurrency !== currency) throw new CxmlError("The cart mixes currencies");
    currency = lineCurrency;

    const desc = childAll(detail, "Description")[0];
    const shortName = textOf(path(desc, "ShortName"));
    const descText = textOf(desc).replace(/\s+/g, " ");
    const name = (shortName || descText || sku).slice(0, 300);
    const lead = textOf(child(detail, "LeadTime"));
    const leadDays = /^\d{1,3}$/.test(lead) && Number(lead) <= 365 ? Number(lead) : null;

    const key = sku.toLowerCase();
    const prior = merged.get(key);
    if (prior) {
      if (prior.unit_price_cents !== cents) throw new CxmlError(`Part ${sku} appears twice with different prices`);
      prior.quantity += quantity;
      if (prior.quantity > 100000) throw new CxmlError("A line has an invalid quantity");
      continue;
    }
    merged.set(key, {
      line_no: merged.size + 1,
      sku,
      aux_id: cut(textOf(path(it, "ItemID", "SupplierPartAuxiliaryID")), 120),
      name,
      description: descText && descText !== name ? cut(descText, 2000) : null,
      mpn: cut(textOf(child(detail, "ManufacturerPartID")), 80),
      manufacturer: cut(textOf(child(detail, "ManufacturerName")), 120),
      uom: mapUom(textOf(child(detail, "UnitOfMeasure"))),
      quantity,
      unit_price_cents: cents,
      lead_time_days: leadDays,
      classification: cut(textOf(child(detail, "Classification")), 60),
    });
  }
  if (!/^[A-Z]{3}$/.test(currency)) throw new CxmlError("The cart has no currency");
  return { buyerCookie, currency, totalCents, lines: [...merged.values()] };
}

/** Builds the cXML reply a supplier's server expects when it posts a cart to a callback (rarely needed; used by tests). */
export function buildOrderMessageForTest(cookie: string, currency: string, items: { sku: string; qty: string; price: string; desc?: string }[]): string {
  return `<?xml version="1.0"?><cXML payloadID="t" timestamp="2026-01-01T00:00:00+00:00"><Header><From><Credential domain="NetworkID"><Identity>s</Identity></Credential></From><To><Credential domain="NetworkID"><Identity>b</Identity></Credential></To><Sender><Credential domain="NetworkID"><Identity>s</Identity></Credential><UserAgent>t</UserAgent></Sender></Header><Message><PunchOutOrderMessage><BuyerCookie>${escapeXml(cookie)}</BuyerCookie><PunchOutOrderMessageHeader operationAllowed="create"><Total><Money currency="${currency}">0</Money></Total></PunchOutOrderMessageHeader>${items
    .map((i) => `<ItemIn quantity="${i.qty}"><ItemID><SupplierPartID>${escapeXml(i.sku)}</SupplierPartID></ItemID><ItemDetail><UnitPrice><Money currency="${currency}">${i.price}</Money></UnitPrice><Description xml:lang="en">${escapeXml(i.desc ?? i.sku)}</Description><UnitOfMeasure>EA</UnitOfMeasure></ItemDetail></ItemIn>`)
    .join("")}</PunchOutOrderMessage></Message></cXML>`;
}
