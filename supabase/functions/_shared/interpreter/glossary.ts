// supabase/functions/_shared/interpreter/glossary.ts
//
// Trade glossary (plumbing, HVAC, electrical) with must-not-confuse notes.
//
// How it is used:
//  1. Before translating, `glossaryHints` finds the terms present in the source
//     and hands the approved target terms to the translator as constraints.
//  2. After translating, `glossaryViolations` checks the output actually used
//     an approved term; a miss lowers confidence (it never blocks the call).
//
// Each entry lists ACCEPTABLE variants (inflection, regional wording). A term is
// only included for a language when it is standard trade usage; missing means
// "no constraint", never a guess. Entries are seed data meant to be extended by
// each business (interpreter_settings.glossary_overrides) and reviewed by
// native-speaking technicians before a language leaves Beta.

import type { InterpLang } from "./languages.ts";
import { INTERP_META } from "./languages.ts";
import { containsPhrase, fold } from "./text.ts";

export type Trade = "plumbing" | "hvac" | "electrical" | "safety";

export interface GlossaryEntry {
  id: string;
  trade: Trade;
  /** Why this term is on the list: the mistake it prevents. */
  mustNot: string;
  terms: Partial<Record<InterpLang, string[]>>;
}

export const GLOSSARY: GlossaryEntry[] = [
  { id: "gas_leak", trade: "safety", mustNot: "never 'gasoline'; a gas leak is a natural-gas/propane emergency", terms: {
    en: ["gas leak"], es: ["fuga de gas", "escape de gas"], pt: ["vazamento de gás"], vi: ["rò rỉ gas", "rò gas", "rò khí gas"], zh: ["燃气泄漏", "煤气泄漏", "漏气"], ar: ["تسرب غاز", "تسرب الغاز"], fa: ["نشت گاز", "نشتی گاز"] } },
  { id: "carbon_monoxide", trade: "safety", mustNot: "never 'carbon dioxide'", terms: {
    en: ["carbon monoxide"], es: ["monóxido de carbono"], pt: ["monóxido de carbono"], vi: ["carbon monoxide", "khí co", "cacbon monoxit"], zh: ["一氧化碳"], ar: ["أول أكسيد الكربون", "اول اكسيد الكربون"], fa: ["مونوکسید کربن"] } },
  { id: "circuit_breaker", trade: "electrical", mustNot: "a breaker is not a light switch", terms: {
    en: ["circuit breaker", "breaker"], es: ["disyuntor", "interruptor automático", "breaker", "pastilla"], pt: ["disjuntor"], vi: ["cầu dao", "át-tô-mát", "aptomat"], zh: ["断路器", "空气开关", "跳闸"], ar: ["قاطع الدائرة", "قاطع كهربائي"], fa: ["کلید اتوماتیک", "فیوز"] } },
  { id: "electrical_panel", trade: "electrical", mustNot: "the main service panel, not a 'control panel'", terms: {
    en: ["electrical panel", "breaker panel", "panel"], es: ["panel eléctrico", "tablero eléctrico", "caja de breakers"], pt: ["quadro elétrico", "quadro de distribuição"], vi: ["tủ điện", "bảng điện"], zh: ["配电箱", "电箱", "电闸箱"], ar: ["لوحة الكهرباء", "لوحة التوزيع"], fa: ["تابلو برق", "تابلوی برق"] } },
  { id: "outlet", trade: "electrical", mustNot: "an outlet (socket) is not a switch", terms: {
    en: ["outlet", "receptacle"], es: ["tomacorriente", "enchufe", "contacto"], pt: ["tomada"], vi: ["ổ cắm"], zh: ["插座"], ar: ["مقبس", "مأخذ كهربائي", "فيشة"], fa: ["پریز"] } },
  { id: "light_switch", trade: "electrical", mustNot: "a wall switch is not a breaker", terms: {
    en: ["light switch"], es: ["interruptor de luz", "apagador", "interruptor"], pt: ["interruptor"], vi: ["công tắc đèn", "công tắc"], zh: ["开关", "电灯开关"], ar: ["مفتاح الإضاءة", "مفتاح كهرباء"], fa: ["کلید برق", "کلید روشنایی"] } },
  { id: "sparks", trade: "electrical", mustNot: "sparks from wiring are an emergency", terms: {
    en: ["sparks"], es: ["chispas"], pt: ["faíscas"], vi: ["tia lửa"], zh: ["火花"], ar: ["شرار", "شرر"], fa: ["جرقه"] } },
  { id: "water_heater", trade: "plumbing", mustNot: "not 'boiler' and not 'furnace'", terms: {
    en: ["water heater"], es: ["calentador de agua"], pt: ["aquecedor de água"], vi: ["máy nước nóng"], zh: ["热水器"], ar: ["سخان المياه", "سخان ماء", "سخان الماء"], fa: ["آبگرمکن"] } },
  { id: "tankless", trade: "plumbing", mustNot: "tankless = on-demand, not a smaller tank", terms: {
    en: ["tankless water heater", "tankless"], es: ["calentador sin tanque"], pt: ["aquecedor sem tanque", "aquecedor de passagem"], vi: ["máy nước nóng trực tiếp"], zh: ["即热式热水器", "无水箱热水器"], ar: ["سخان بدون خزان"], fa: ["آبگرمکن بدون مخزن"] } },
  { id: "burst_pipe", trade: "plumbing", mustNot: "burst, not merely 'leaking'", terms: {
    en: ["burst pipe"], es: ["tubería rota", "tubería reventada", "tubo roto"], pt: ["cano estourado", "cano rompido", "tubulação rompida"], vi: ["ống nước bị vỡ", "vỡ ống", "ống bị vỡ"], zh: ["水管爆裂", "爆管", "水管破裂"], ar: ["انفجار أنبوب", "أنبوب مكسور", "ماسورة مكسورة"], fa: ["ترکیدگی لوله", "لوله ترکیده"] } },
  { id: "clogged_drain", trade: "plumbing", mustNot: "clogged drain, not 'sewer line collapse'", terms: {
    en: ["clogged drain", "blocked drain"], es: ["desagüe tapado", "drenaje tapado", "tubo tapado"], pt: ["ralo entupido", "entupimento"], vi: ["tắc cống", "cống bị nghẽn", "nghẹt cống"], zh: ["下水道堵塞", "管道堵塞"], ar: ["انسداد المجاري", "انسداد الصرف"], fa: ["گرفتگی فاضلاب", "گرفتگی"] } },
  { id: "shutoff_valve", trade: "plumbing", mustNot: "the valve that stops water, not the faucet", terms: {
    en: ["shut-off valve", "shutoff valve", "main valve"], es: ["válvula de cierre", "llave de paso"], pt: ["registro", "válvula de fechamento", "válvula de corte"], vi: ["van khóa", "van chặn"], zh: ["截止阀", "总阀", "阀门"], ar: ["صمام الإغلاق", "محبس"], fa: ["شیر قطع", "شیر اصلی"] } },
  { id: "toilet", trade: "plumbing", mustNot: "the fixture, not 'bathroom' in general", terms: {
    en: ["toilet"], es: ["inodoro", "excusado", "sanitario"], pt: ["vaso sanitário", "privada", "sanita"], vi: ["bồn cầu", "toilet"], zh: ["马桶"], ar: ["مرحاض"], fa: ["توالت", "کاسه توالت"] } },
  { id: "water_pressure", trade: "plumbing", mustNot: "pressure, not 'flow rate'", terms: {
    en: ["water pressure"], es: ["presión del agua", "presión de agua"], pt: ["pressão da água"], vi: ["áp lực nước"], zh: ["水压"], ar: ["ضغط المياه", "ضغط الماء"], fa: ["فشار آب"] } },
  { id: "air_conditioner", trade: "hvac", mustNot: "cooling unit, not 'heater'", terms: {
    en: ["air conditioner", "ac unit", "a/c"], es: ["aire acondicionado"], pt: ["ar-condicionado", "ar condicionado"], vi: ["máy lạnh", "điều hòa", "máy điều hòa"], zh: ["空调"], ar: ["مكيف", "مكيّف"], fa: ["کولر گازی", "کولر"] } },
  { id: "thermostat", trade: "hvac", mustNot: "the wall control, not 'thermometer'", terms: {
    en: ["thermostat"], es: ["termostato"], pt: ["termostato"], vi: ["bộ điều nhiệt", "bộ điều khiển nhiệt độ"], zh: ["温控器", "恒温器"], ar: ["ثرموستات", "منظم الحرارة"], fa: ["ترموستات"] } },
  { id: "furnace", trade: "hvac", mustNot: "furnace = forced-air heater, not 'oven' or 'boiler'", terms: {
    en: ["furnace"], es: ["calefactor", "horno de calefacción"], zh: ["暖气炉", "燃气炉", "炉子"] } },
  { id: "compressor", trade: "hvac", mustNot: "AC compressor, not 'air compressor tool'", terms: {
    en: ["compressor"], es: ["compresor"], pt: ["compressor"], vi: ["máy nén"], zh: ["压缩机"], ar: ["ضاغط", "كمبريسور"], fa: ["کمپرسور"] } },
  { id: "refrigerant", trade: "hvac", mustNot: "refrigerant, not 'coolant' (engine)", terms: {
    en: ["refrigerant", "freon"], es: ["refrigerante"], pt: ["refrigerante", "gás refrigerante"], vi: ["môi chất lạnh", "gas lạnh"], zh: ["制冷剂", "冷媒"], ar: ["غاز التبريد", "سائل التبريد"], fa: ["گاز مبرد", "مبرد"] } },
  { id: "flooding", trade: "plumbing", mustNot: "active flooding is urgent", terms: {
    en: ["flooding", "flood"], es: ["inundación"], pt: ["alagamento", "inundação"], vi: ["ngập nước", "ngập"], zh: ["淹水", "水淹", "积水"], ar: ["فيضان", "غمر المياه"], fa: ["آب‌گرفتگی", "آبگرفتگی", "سیل"] } },
];

export interface GlossaryHint {
  id: string;
  /** Term as it appears in the source language. */
  source: string;
  /** Approved target term(s); the first is preferred. */
  target: string[];
  mustNot: string;
}

type Overrides = Record<string, Partial<Record<InterpLang, string[]>>>;

function termsFor(entry: GlossaryEntry, lang: InterpLang, overrides?: Overrides): string[] {
  return [...(overrides?.[entry.id]?.[lang] ?? []), ...(entry.terms[lang] ?? [])];
}

/** Terms present in `text` (written in `from`) that have an approved rendering in `to`. */
export function glossaryHints(text: string, from: InterpLang, to: InterpLang, overrides?: Overrides): GlossaryHint[] {
  const hay = fold(text, from);
  const noSpaces = INTERP_META[from].noSpaces;
  const hints: GlossaryHint[] = [];
  for (const e of GLOSSARY) {
    const src = termsFor(e, from, overrides);
    const tgt = termsFor(e, to, overrides);
    if (!src.length || !tgt.length) continue;
    const hit = src.find((t) => containsPhrase(hay, fold(t, from), noSpaces));
    if (hit) hints.push({ id: e.id, source: hit, target: tgt, mustNot: e.mustNot });
  }
  return hints;
}

/** Hints whose approved target term is absent from the translation. */
export function glossaryViolations(output: string, hints: GlossaryHint[], to: InterpLang): GlossaryHint[] {
  const hay = fold(output, to);
  const noSpaces = INTERP_META[to].noSpaces;
  return hints.filter((h) => !h.target.some((t) => hay.includes(fold(t, to)) || containsPhrase(hay, fold(t, to), noSpaces)));
}

export function glossaryPromptBlock(hints: GlossaryHint[]): string {
  if (!hints.length) return "";
  return hints.map((h) => `- "${h.source}" -> ${h.target.map((t) => `"${t}"`).join(" or ")} (${h.mustNot})`).join("\n");
}
