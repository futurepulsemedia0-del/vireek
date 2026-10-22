/* ------------------------------------------------------------------ */
/*  Tax engine: VAT (EU/UK), GST (AU/CA), HST/PST/QST (CA).            */
/*  Pure + deterministic. Integer minor units, integer-rate maths.     */
/*                                                                      */
/*  Home-service rule: work on real property is taxed where the        */
/*  property is (place of supply = job site), not where the customer   */
/*  lives or the business is established.                              */
/*  US sales tax is NOT re-implemented here: pass the components from  */
/*  the existing engine (salesTaxApi.lookupTaxRates) as                */
/*  `externalComponents`.                                               */
/* ------------------------------------------------------------------ */
import { allocate, applyRate } from './packMoney';
import { getCountry } from './packData';
import type {
  RateCategory, TaxBreakdownRow, TaxComponentRate, TaxContext, TaxLineInput, TaxLineResult,
  TaxRegistration, TaxResult, TaxScheme, TaxStatus, Warning,
} from './packTypes';

const up = (s: string | null | undefined) => (s ? s.trim().toUpperCase() : '');
const todayIso = () => new Date().toISOString().slice(0, 10);

/* ----------------------------- Canada table ------------------------- */

const GST: TaxComponentRate = { code: 'GST', label: 'GST', ratePct: 5, scheme: 'GST_HST' };
const hst = (pct: number): TaxComponentRate[] => [{ code: 'HST', label: 'HST', ratePct: pct, scheme: 'GST_HST' }];

export const CA_TAX_BY_PROVINCE: Readonly<Record<string, readonly TaxComponentRate[]>> = {
  AB: [GST], NT: [GST], NU: [GST], YT: [GST],
  BC: [GST, { code: 'PST', label: 'PST (BC)', ratePct: 7, scheme: 'PST_BC' }],
  SK: [GST, { code: 'PST', label: 'PST (SK)', ratePct: 6, scheme: 'PST_SK' }],
  MB: [GST, { code: 'RST', label: 'RST (MB)', ratePct: 7, scheme: 'RST_MB' }],
  QC: [GST, { code: 'QST', label: 'QST', ratePct: 9.975, scheme: 'QST' }],
  ON: hst(13), NB: hst(15), NL: hst(15), PE: hst(15), NS: hst(14),
};

/** Rates that were different before a recent change (so credit notes/back-dated invoices stay right). */
interface Superseded { country: string; subdivision?: string; until: string; standard?: number; reduced?: number[] }
const SUPERSEDED: readonly Superseded[] = [
  { country: 'EE', until: '2025-06-30', standard: 22 },
  { country: 'SK', until: '2024-12-31', standard: 20, reduced: [10] },
  { country: 'RO', until: '2025-07-31', standard: 19, reduced: [5, 9] },
  { country: 'FI', until: '2025-12-31', reduced: [10, 14] },
  { country: 'CA', subdivision: 'NS', until: '2025-03-31', standard: 15 },
];

const DOMESTIC_RC_HINT = new Set(['GB', 'DE', 'FR', 'NL', 'IE', 'BE', 'AT', 'ES', 'IT']);

/* ------------------------- component resolution --------------------- */

export interface ResolvedRates {
  components: TaxComponentRate[];
  warnings: Warning[];
}

/** Rate components for one category in one jurisdiction on one date. Throws on an unknown jurisdiction. */
export function taxComponentsFor(
  country: string, subdivision: string | null | undefined, category: RateCategory,
  reducedIndex = 0, onDate: string = todayIso(),
): ResolvedRates {
  const cc = up(country);
  const sub = up(subdivision);
  const profile = getCountry(cc);
  if (!profile) throw new Error(`No regional pack covers country "${cc}".`);
  const warnings: Warning[] = [];
  if (category === 'zero' || category === 'exempt') return { components: [], warnings };

  const old = SUPERSEDED.find((s) => s.country === cc && (!s.subdivision || s.subdivision === sub) && onDate <= s.until);

  if (cc === 'CA') {
    if (!sub || !CA_TAX_BY_PROVINCE[sub]) throw new Error('Canada needs a valid province/territory to pick GST/HST/PST/QST.');
    let comps = CA_TAX_BY_PROVINCE[sub].map((c) => ({ ...c }));
    if (old?.standard != null) comps = hst(old.standard);
    if (category === 'reduced') warnings.push({ code: 'NO_REDUCED_RATE', message: 'Canada has no general reduced rate; zero-rated supplies should use the zero category. Standard rates applied.' });
    return { components: comps, warnings };
  }
  if (cc === 'AU') {
    if (category === 'reduced') warnings.push({ code: 'NO_REDUCED_RATE', message: 'Australia has a single GST rate; use the zero (GST-free) category where it applies. Standard rate applied.' });
    return { components: [{ code: 'GST', label: 'GST', ratePct: 10, scheme: 'AU_GST' }], warnings };
  }
  if (cc === 'US') throw new Error('US sales tax comes from the Sales Tax engine — pass externalComponents.');

  const vat = profile.vat!;
  const standard = old?.standard ?? vat.standard;
  const reduced = old?.reduced ?? [...vat.reduced];
  let pct = standard;
  if (category === 'reduced') {
    if (reduced.length === 0) warnings.push({ code: 'NO_REDUCED_RATE', message: `${profile.name} has no reduced VAT rate on record. Standard rate applied.` });
    else if (reducedIndex < 0 || reducedIndex >= reduced.length) throw new Error('reducedIndex out of range.');
    else pct = reduced[reducedIndex];
  }
  return { components: [{ code: 'VAT', label: 'VAT', ratePct: pct, scheme: 'VAT' }], warnings };
}

/* ----------------------------- registrations ------------------------ */

export function hasRegistration(
  regs: readonly TaxRegistration[], scheme: TaxScheme, country: string, subdivision: string | null | undefined, onDate: string,
): boolean {
  const cc = up(country);
  const sub = up(subdivision);
  return regs.some((r) => {
    if (r.scheme !== scheme || up(r.country) !== cc) return false;
    if ((r.status ?? 'active') !== 'active' || !r.number.trim()) return false;
    if (scheme.startsWith('PST_') || scheme === 'RST_MB') {
      const need = scheme === 'PST_BC' ? 'BC' : scheme === 'PST_SK' ? 'SK' : 'MB';
      if (r.subdivision && up(r.subdivision) !== need) return false;
      if (sub && sub !== need) return false;
    }
    if (r.validFrom && onDate < r.validFrom) return false;
    if (r.validTo && onDate > r.validTo) return false;
    return true;
  });
}

/** Loose structural match of a tax id to a country (checksum/VIES checks live in packValidation). */
function taxIdMatchesCountry(id: string | null | undefined, country: string): boolean {
  if (!id) return false;
  const profile = getCountry(country);
  if (!profile?.vat) return false;
  return up(id).replace(/[\s.-]/g, '').startsWith(profile.vat.idPrefix);
}

/* -------------------------------- engine ---------------------------- */

function emptyResult(ctx: TaxContext, lines: TaxLineInput[], status: TaxStatus, warnings: Warning[], notes: string[]): TaxResult {
  const net = lines.reduce((a, l) => a + l.netMinor, 0);
  return {
    status, currency: ctx.currency.toUpperCase(), netMinor: net, taxMinor: 0, grossMinor: net,
    lines: lines.map((l) => ({ id: l.id, netMinor: l.netMinor, taxMinor: 0, grossMinor: l.netMinor, category: l.category ?? 'standard', components: [] })),
    breakdown: [], reverseCharge: false,
    placeOfSupply: { country: up(ctx.siteCountry), subdivision: up(ctx.siteSubdivision) || null },
    notes, warnings,
  };
}

export function computeTax(ctx: TaxContext, input: readonly TaxLineInput[]): TaxResult {
  const lines = [...input];
  for (const l of lines) {
    if (!Number.isInteger(l.netMinor)) throw new Error(`Line "${l.id}": netMinor must be an integer (minor units).`);
  }
  const date = ctx.supplyDate ?? todayIso();
  const siteCountry = up(ctx.siteCountry);
  const siteSub = up(ctx.siteSubdivision) || null;
  const sellerCountry = up(ctx.sellerCountry);
  const warnings: Warning[] = [];
  const notes: string[] = [`Place of supply: job site (${siteSub ? `${siteSub}, ` : ''}${siteCountry}) — work on real property is taxed where the property is.`];

  const profile = getCountry(siteCountry);
  if (!profile) {
    warnings.push({ code: 'NO_PACK', message: `No regional pack covers ${siteCountry || 'this country'}; no tax was calculated.` });
    return emptyResult(ctx, lines, 'out_of_scope', warnings, notes);
  }

  /* ---- US: delegate rates to the existing sales-tax engine ---- */
  if (siteCountry === 'US') {
    if (!ctx.externalComponents) {
      warnings.push({ code: 'NEEDS_RATE', message: 'US sales tax depends on the service address and taxability. Resolve it with the Sales Tax engine and pass externalComponents.' });
      return emptyResult(ctx, lines, 'needs_rate', warnings, notes);
    }
    return finalize(ctx, lines, ctx.externalComponents, false, warnings, notes, 'ok');
  }

  /* ---- cross-border / reverse charge decisions ---- */
  const established = sellerCountry === siteCountry;
  const anyTaxable = lines.some((l) => (l.category ?? 'standard') === 'standard' || l.category === 'reduced');

  if (ctx.domesticReverseCharge) {
    if (!ctx.customerIsBusiness || !ctx.customerTaxId) {
      warnings.push({ code: 'RC_NEEDS_TAX_ID', message: 'Domestic reverse charge needs a VAT-registered business customer with a tax id.' });
    } else {
      notes.push('Domestic reverse charge applied — the customer accounts for the tax.');
      return finalize(ctx, lines, [], true, warnings, notes, 'ok');
    }
  } else if (anyTaxable && ctx.customerIsBusiness && DOMESTIC_RC_HINT.has(siteCountry) && established) {
    warnings.push({ code: 'DOMESTIC_RC_CHECK', message: `Construction-type work for a VAT-registered business can fall under a domestic reverse charge in ${profile.name}. Confirm with your accountant; set domesticReverseCharge if it applies.` });
  }

  if (!established && ctx.customerIsBusiness && taxIdMatchesCountry(ctx.customerTaxId, siteCountry) && profile.pack !== 'CA' && profile.pack !== 'AU') {
    notes.push('Cross-border B2B supply: reverse charge — the customer accounts for the VAT in the country of the property.');
    return finalize(ctx, lines, [], true, warnings, notes, 'ok');
  }

  /* ---- component selection (per distinct category/index) ---- */
  const needsComponents = anyTaxable;
  let ratesByKey = new Map<string, TaxComponentRate[]>();
  if (needsComponents) {
    for (const l of lines) {
      const cat = l.category ?? 'standard';
      if (cat === 'zero' || cat === 'exempt') continue;
      const key = `${cat}:${l.reducedIndex ?? 0}`;
      if (ratesByKey.has(key)) continue;
      const r = taxComponentsFor(siteCountry, siteSub, cat, l.reducedIndex ?? 0, date);
      for (const w of r.warnings) if (!warnings.some((x) => x.code === w.code)) warnings.push(w);
      ratesByKey.set(key, r.components);
    }
  }

  /* ---- registration gate ---- */
  let status: TaxStatus = 'ok';
  const allowed = new Map<string, TaxComponentRate[]>();
  const dropped = new Set<TaxScheme>();
  for (const [key, comps] of ratesByKey) {
    const kept = comps.filter((c) => {
      if (ctx.assumeRegistered) return true;
      const ok = hasRegistration(ctx.registrations, c.scheme, siteCountry, siteSub, date);
      if (!ok) dropped.add(c.scheme);
      return ok;
    });
    allowed.set(key, kept);
  }
  if (dropped.size > 0) {
    status = [...allowed.values()].every((c) => c.length === 0) ? 'no_registration' : 'needs_review';
    for (const s of dropped) {
      warnings.push({
        code: 'NOT_REGISTERED',
        message: `No active ${s.replace('_', '/')} registration for ${siteSub || siteCountry} — that tax was not charged. Add the registration in Regional Packs → Tax, or confirm you are below the registration threshold.`,
      });
    }
    if (!established) warnings.push({ code: 'FOREIGN_SUPPLIER', message: `You are not established in ${profile.name}. Charging local tax there generally requires a local registration.` });
  }

  ratesByKey = allowed;
  return finalize(ctx, lines, ratesByKey, false, warnings, notes, status);
}

type RateSource = readonly TaxComponentRate[] | Map<string, TaxComponentRate[]>;

function finalize(
  ctx: TaxContext, lines: TaxLineInput[], source: RateSource, reverseCharge: boolean,
  warnings: Warning[], notes: string[], status: TaxStatus,
): TaxResult {
  const perLine = ctx.rounding === 'per_line';
  const componentsFor = (l: TaxLineInput): readonly TaxComponentRate[] => {
    const cat: RateCategory = l.category ?? 'standard';
    if (reverseCharge || cat === 'zero' || cat === 'exempt') return [];
    if (source instanceof Map) return source.get(`${cat}:${l.reducedIndex ?? 0}`) ?? [];
    return source;
  };

  const lineTax: number[][] = lines.map(() => []); // per line, per component slot
  const slots = new Map<string, { comp: TaxComponentRate; lineIdx: number[] }>();
  lines.forEach((l, i) => {
    for (const c of componentsFor(l)) {
      const key = `${c.code}|${c.ratePct}|${c.label}`;
      const s = slots.get(key) ?? { comp: c, lineIdx: [] };
      s.lineIdx.push(i);
      slots.set(key, s);
    }
  });

  const lineComps: TaxLineResult['components'][] = lines.map(() => []);
  const breakdown: TaxBreakdownRow[] = [];
  for (const { comp, lineIdx } of slots.values()) {
    const nets = lineIdx.map((i) => lines[i].netMinor);
    const netSum = nets.reduce((a, b) => a + b, 0);
    const taxes = perLine
      ? nets.map((n) => applyRate(n, comp.ratePct))
      : allocate(applyRate(netSum, comp.ratePct), nets);
    lineIdx.forEach((li, k) => {
      lineComps[li].push({ code: comp.code, ratePct: comp.ratePct, taxMinor: taxes[k] });
      lineTax[li].push(taxes[k]);
    });
    breakdown.push({ code: comp.code, label: comp.label, ratePct: comp.ratePct, netMinor: netSum, taxMinor: taxes.reduce((a, b) => a + b, 0) });
  }

  const results: TaxLineResult[] = lines.map((l, i) => {
    const tax = lineTax[i].reduce((a, b) => a + b, 0);
    return { id: l.id, netMinor: l.netMinor, taxMinor: tax, grossMinor: l.netMinor + tax, category: l.category ?? 'standard', components: lineComps[i] };
  });
  const net = results.reduce((a, r) => a + r.netMinor, 0);
  const tax = results.reduce((a, r) => a + r.taxMinor, 0);
  return {
    status, currency: ctx.currency.toUpperCase(), netMinor: net, taxMinor: tax, grossMinor: net + tax,
    lines: results, breakdown, reverseCharge,
    placeOfSupply: { country: up(ctx.siteCountry), subdivision: up(ctx.siteSubdivision) || null },
    notes, warnings,
  };
}

/** Convenience for UI previews: combined headline rate (%) of a component list. */
export function combinedRatePct(components: readonly TaxComponentRate[]): number {
  return Math.round(components.reduce((a, c) => a + c.ratePct, 0) * 1000) / 1000;
}
