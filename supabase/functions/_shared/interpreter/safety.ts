// supabase/functions/_shared/interpreter/safety.ts
//
// Emergency detection and the ONLY safety advice the interpreter may speak.
//
//  - detectEmergency runs on every utterance in EVERY supported language, no
//    matter which language was detected (language-ID can be wrong on exactly
//    the frightened, noisy calls that matter most).
//  - SAFETY_INSTRUCTIONS is fixed, pre-written text. A model never composes
//    safety advice: not in translation, not in the assistant, not in captions.
//    Anything beyond these lines goes to a human immediately.
//  - Emergency handling never waits on translation or confidence: the caller
//    hears the approved line in their own language first.

import { INTERP_LANGUAGES, INTERP_META, type InterpLang } from "./languages.ts";
import { containsPhrase, fold } from "./text.ts";

export type EmergencyKind = "gas" | "fire" | "co" | "flood" | "electrical" | "medical" | "general";

type Terms = Partial<Record<EmergencyKind, string[]>>;

export const EMERGENCY_TERMS: Record<InterpLang, Terms> = {
  en: {
    gas: ["smell gas", "smells like gas", "gas smell", "gas leak", "gas leaking", "smell of gas"],
    fire: ["fire", "on fire", "smoke", "smoking", "something burning", "burning smell"],
    co: ["carbon monoxide", "co alarm", "co detector"],
    flood: ["flood", "flooding", "flooded", "burst pipe", "pipe burst", "water everywhere"],
    electrical: ["sparks", "sparking", "electrical fire", "electrocuted", "got shocked", "electric shock", "got a shock"],
    medical: ["can't breathe", "cannot breathe", "can not breathe", "unconscious", "heart attack"],
    general: ["emergency"],
  },
  es: {
    gas: ["huele a gas", "olor a gas", "fuga de gas", "escape de gas", "huelo gas"],
    fire: ["fuego", "incendio", "humo", "se esta quemando", "se esta incendiando", "esta ardiendo"],
    co: ["monoxido de carbono"],
    flood: ["inundacion", "inundando", "se inunda", "tuberia rota", "tuberia reventada", "tubo roto", "se revento", "se rompio una tuberia", "agua por todas partes"],
    electrical: ["chispas", "descarga electrica", "me electrocute", "cortocircuito", "corto circuito"],
    medical: ["no puedo respirar", "inconsciente", "infarto"],
    general: ["emergencia", "urgencia"],
  },
  pt: {
    gas: ["cheiro de gas", "cheiro a gas", "vazamento de gas", "vazando gas", "sinto cheiro de gas"],
    fire: ["fogo", "incendio", "fumaca", "pegando fogo", "esta queimando"],
    co: ["monoxido de carbono"],
    flood: ["alagamento", "alagando", "inundacao", "inundando", "cano estourou", "cano estourado", "cano rompeu"],
    electrical: ["faiscas", "choque eletrico", "levei choque", "curto circuito", "curto-circuito"],
    medical: ["nao consigo respirar", "inconsciente", "infarto"],
    general: ["emergencia", "urgencia"],
  },
  vi: {
    gas: ["mùi gas", "rò gas", "rò rỉ gas", "rò khí gas", "ngửi thấy gas", "có mùi gas"],
    fire: ["cháy", "hỏa hoạn", "hoả hoạn", "có khói", "bốc khói", "khói đen"],
    co: ["khí co", "carbon monoxide", "cacbon monoxit", "co báo động"],
    flood: ["ngập nước", "nước ngập", "vỡ ống", "ống nước vỡ", "ống bị vỡ", "ống nước bị vỡ", "ngập khắp", "tràn nước"],
    electrical: ["tia lửa", "giật điện", "điện giật", "chập điện", "bị điện giật"],
    medical: ["không thở được", "bất tỉnh", "đau tim"],
    general: ["khẩn cấp", "cấp cứu"],
  },
  zh: {
    gas: ["煤气泄漏", "燃气泄漏", "漏气", "煤气味", "燃气味", "闻到煤气", "闻到燃气", "天然气泄漏"],
    fire: ["着火", "起火", "火灾", "冒烟", "浓烟", "烟味", "失火"],
    co: ["一氧化碳"],
    flood: ["淹水", "水淹", "发大水", "水管爆", "爆管", "水管破裂", "积水"],
    electrical: ["漏电", "触电", "火花", "冒火花", "电火花", "短路"],
    medical: ["无法呼吸", "喘不过气", "昏迷", "心脏病发"],
    general: ["紧急", "救命", "急救"],
  },
  ar: {
    gas: ["رائحة غاز", "ريحة غاز", "تسرب غاز", "تسريب غاز", "تسرب الغاز", "اشم غاز", "اشم رائحة غاز"],
    fire: ["حريق", "نار", "النار", "دخان", "يحترق", "تحترق", "اشتعال"],
    co: ["اول اكسيد الكربون", "أول أكسيد الكربون", "اول أكسيد الكربون"],
    flood: ["فيضان", "غرق", "تسرب مياه", "انفجار ماسوره", "انفجار انبوب", "انفجار أنبوب", "انفجر الانبوب", "انفجرت الماسوره", "ماسوره مكسوره", "ماسورة مكسورة", "المياه تغمر"],
    electrical: ["شرار", "شرر", "صعق", "صعقه كهربائيه", "ماس كهربائي", "تماس كهربائي", "صعقة"],
    medical: ["لا استطيع التنفس", "لا أستطيع التنفس", "فاقد الوعي", "نوبه قلبيه"],
    general: ["طوارئ", "نجده", "النجدة"],
  },
  fa: {
    gas: ["بوی گاز", "نشت گاز", "نشتی گاز", "بوي گاز", "گاز نشت"],
    fire: ["آتش", "اتش", "آتیش", "آتش‌سوزی", "آتش سوزی", "دود", "می‌سوزد", "میسوزه"],
    co: ["مونوکسید کربن", "منو کسید کربن", "مونوکسیدکربن"],
    flood: ["سیل", "آب‌گرفتگی", "آبگرفتگی", "آب گرفتگی", "ترکیدگی لوله", "لوله ترکید", "لوله ترکیده", "لوله‌ام ترکید"],
    electrical: ["جرقه", "برق گرفتگی", "برق گرفت", "اتصال برق", "اتصالی"],
    medical: ["نمی‌توانم نفس", "نفس نمی‌کشم", "نفس نمیتونم", "بیهوش", "حمله قلبی"],
    general: ["اورژانس", "فوری"],
  },
  hi: {
    gas: ["गैस की गंध", "गैस की बदबू", "गैस लीक", "गैस रिसाव", "गैस की महक"],
    fire: ["आग", "धुआं", "धुआँ", "जल रहा"],
    co: ["कार्बन मोनोऑक्साइड", "कार्बन मोनोक्साइड"],
    flood: ["बाढ़", "पाइप फट", "पानी भर गया", "पानी भर रहा"],
    electrical: ["चिंगारी", "करंट", "बिजली का झटका", "शॉर्ट सर्किट"],
    medical: ["सांस नहीं", "साँस नहीं", "बेहोश", "दिल का दौरा"],
    general: ["आपातकाल", "इमरजेंसी"],
  },
  fr: {
    gas: ["odeur de gaz", "fuite de gaz", "sent le gaz", "je sens le gaz", "ca sent le gaz"],
    fire: ["feu", "incendie", "fumee", "ca brule", "ca crame"],
    co: ["monoxyde de carbone"],
    flood: ["inondation", "inonde", "tuyau eclate", "tuyau a eclate", "degat des eaux", "fuite d'eau importante"],
    electrical: ["etincelles", "electrocute", "decharge electrique", "court-circuit", "court circuit"],
    medical: ["je ne peux pas respirer", "inconscient", "crise cardiaque"],
    general: ["urgence"],
  },
  de: {
    gas: ["gasgeruch", "gas geruch", "ich rieche gas", "gasleck", "es riecht nach gas"],
    fire: ["feuer", "brand", "rauch", "es brennt", "brennt"],
    co: ["kohlenmonoxid"],
    flood: ["uberschwemmung", "uberflutung", "rohrbruch", "wasser lauft uberall", "wasserrohrbruch"],
    electrical: ["funken", "stromschlag", "kurzschluss", "elektrischen schlag"],
    medical: ["kann nicht atmen", "bewusstlos", "herzinfarkt"],
    general: ["notfall"],
  },
  ja: {
    gas: ["ガス漏れ", "ガスのにおい", "ガスの臭い", "ガス臭い", "ガスくさい"],
    fire: ["火事", "火災", "煙が", "燃えて"],
    co: ["一酸化炭素"],
    flood: ["洪水", "浸水", "水浸し", "水道管が破裂", "配管が破裂", "破裂"],
    electrical: ["漏電", "感電", "火花", "ショート"],
    medical: ["息ができない", "意識がない", "心臓発作"],
    general: ["緊急", "救急", "助けて"],
  },
};

export interface EmergencyResult {
  isEmergency: boolean;
  kinds: EmergencyKind[];
  /** Which language list matched (for audit / debugging). */
  matched: { lang: InterpLang; kind: EmergencyKind; term: string }[];
}

const NONE: EmergencyResult = { isEmergency: false, kinds: [], matched: [] };

// Pre-fold every term once, per language, with that language's folding policy.
const FOLDED: { lang: InterpLang; kind: EmergencyKind; term: string; folded: string }[] = [];
for (const lang of INTERP_LANGUAGES) {
  for (const [kind, terms] of Object.entries(EMERGENCY_TERMS[lang]) as [EmergencyKind, string[]][]) {
    for (const term of terms) FOLDED.push({ lang, kind, term, folded: fold(term, lang) });
  }
}

/** Runs ALL languages' terms against the text, each with its own folding policy. */
export function detectEmergency(text: string | null | undefined): EmergencyResult {
  if (typeof text !== "string" || !text.trim()) return NONE;
  const folds = new Map<InterpLang, string>();
  const textFor = (lang: InterpLang): string => {
    let f = folds.get(lang);
    if (f === undefined) {
      f = fold(text, lang);
      folds.set(lang, f);
    }
    return f;
  };
  const matched: EmergencyResult["matched"] = [];
  for (const e of FOLDED) {
    if (containsPhrase(textFor(e.lang), e.folded, INTERP_META[e.lang].noSpaces || e.lang === "ja")) {
      matched.push({ lang: e.lang, kind: e.kind, term: e.term });
    }
  }
  if (!matched.length) return NONE;
  const kinds = [...new Set(matched.map((m) => m.kind))];
  return { isEmergency: true, kinds, matched };
}

// ---------------------------------------------------------------------------
// Approved safety lines. Fixed text, never model output.
// ---------------------------------------------------------------------------
export type SafetyKey = "gas" | "fire" | "co";

export const SAFETY_INSTRUCTIONS: Record<SafetyKey, Record<InterpLang, string>> = {
  gas: {
    en: "If you smell gas, leave the building now. Do not use light switches, phones, or flames inside. Call 911 from outside.",
    es: "Si huele a gas, salga del edificio ahora. No use interruptores de luz, teléfonos ni llamas dentro. Llame al 911 desde afuera.",
    pt: "Se sentir cheiro de gás, saia do imóvel agora. Não use interruptores, telefones nem chamas dentro de casa. Ligue para o 911 do lado de fora.",
    vi: "Nếu ngửi thấy mùi gas, hãy ra khỏi nhà ngay. Không bật công tắc điện, không dùng điện thoại hay lửa bên trong. Hãy gọi 911 từ bên ngoài.",
    zh: "如果闻到煤气味，请立即离开房屋。屋内不要开关电灯、使用手机或明火。请到户外拨打911。",
    ar: "إذا شممتم رائحة غاز، فاخرجوا من المبنى فوراً. لا تستخدموا مفاتيح الإضاءة أو الهواتف أو أي لهب في الداخل. اتصلوا بالرقم 911 من الخارج.",
    fa: "اگر بوی گاز حس می‌کنید، همین الان از ساختمان خارج شوید. داخل ساختمان از کلید برق، تلفن یا شعله استفاده نکنید. از بیرون با 911 تماس بگیرید.",
    hi: "अगर गैस की गंध आए, तो तुरंत इमारत से बाहर निकल जाएँ। अंदर लाइट के स्विच, फ़ोन या आग का इस्तेमाल न करें। बाहर से 911 पर कॉल करें।",
    fr: "Si vous sentez le gaz, quittez le bâtiment immédiatement. N'utilisez ni interrupteurs, ni téléphones, ni flammes à l'intérieur. Appelez le 911 depuis l'extérieur.",
    de: "Wenn Sie Gas riechen, verlassen Sie sofort das Gebäude. Benutzen Sie drinnen keine Lichtschalter, Telefone oder offene Flammen. Rufen Sie von draußen die 911 an.",
    ja: "ガスのにおいがしたら、すぐに建物の外に出てください。屋内では電気のスイッチや電話、火を使わないでください。外から911に電話してください。",
  },
  fire: {
    en: "If there is fire or heavy smoke, get everyone out now and call 911 from outside. Do not go back inside.",
    es: "Si hay fuego o mucho humo, saque a todos ahora y llame al 911 desde afuera. No vuelva a entrar.",
    pt: "Se houver fogo ou muita fumaça, tire todos de casa agora e ligue para o 911 do lado de fora. Não volte para dentro.",
    vi: "Nếu có cháy hoặc nhiều khói, hãy đưa mọi người ra ngoài ngay và gọi 911 từ bên ngoài. Không quay lại bên trong.",
    zh: "如果着火或烟雾很大，请立即带所有人离开，并在户外拨打911。不要返回屋内。",
    ar: "إذا اندلع حريق أو كان هناك دخان كثيف، فأخرجوا الجميع فوراً واتصلوا بالرقم 911 من الخارج. لا تعودوا إلى الداخل.",
    fa: "اگر آتش‌سوزی یا دود زیاد است، همه را همین الان بیرون ببرید و از بیرون با 911 تماس بگیرید. به داخل برنگردید.",
    hi: "अगर आग लगी हो या बहुत धुआँ हो, तो सभी को तुरंत बाहर निकालें और बाहर से 911 पर कॉल करें। वापस अंदर न जाएँ।",
    fr: "En cas d'incendie ou de fumée épaisse, faites sortir tout le monde immédiatement et appelez le 911 depuis l'extérieur. Ne retournez pas à l'intérieur.",
    de: "Bei Feuer oder starkem Rauch bringen Sie sofort alle nach draußen und rufen Sie von dort die 911 an. Gehen Sie nicht zurück ins Gebäude.",
    ja: "火事や濃い煙が出ている場合は、すぐに全員を外に避難させ、外から911に電話してください。建物に戻らないでください。",
  },
  co: {
    en: "If a carbon monoxide alarm is sounding or anyone feels dizzy or sick, get everyone outside into fresh air now and call 911.",
    es: "Si suena una alarma de monóxido de carbono o alguien se siente mareado o enfermo, saque a todos al aire libre ahora y llame al 911.",
    pt: "Se o alarme de monóxido de carbono tocar ou alguém sentir tontura ou mal-estar, leve todos para o ar livre agora e ligue para o 911.",
    vi: "Nếu chuông báo khí carbon monoxide kêu hoặc có người chóng mặt, buồn nôn, hãy đưa mọi người ra ngoài nơi thoáng khí ngay và gọi 911.",
    zh: "如果一氧化碳报警器响起，或有人感到头晕不适，请立即带所有人到室外呼吸新鲜空气，并拨打911。",
    ar: "إذا انطلق إنذار أول أكسيد الكربون أو شعر أحد بالدوار أو التعب، فأخرجوا الجميع إلى الهواء الطلق فوراً واتصلوا بالرقم 911.",
    fa: "اگر آلارم مونوکسید کربن به صدا درآمد یا کسی سرگیجه یا حال بد دارد، همه را همین الان به هوای آزاد ببرید و با 911 تماس بگیرید.",
    hi: "अगर कार्बन मोनोऑक्साइड का अलार्म बजे या किसी को चक्कर या बीमार महसूस हो, तो सभी को तुरंत खुली हवा में ले जाएँ और 911 पर कॉल करें।",
    fr: "Si une alarme de monoxyde de carbone retentit ou si quelqu'un se sent étourdi ou malade, faites sortir tout le monde à l'air frais immédiatement et appelez le 911.",
    de: "Wenn ein Kohlenmonoxid-Alarm ertönt oder jemandem schwindlig oder übel ist, bringen Sie sofort alle an die frische Luft und rufen Sie die 911 an.",
    ja: "一酸化炭素警報器が鳴った場合や、めまいや気分の悪さを感じる人がいる場合は、すぐに全員を屋外の新鮮な空気のある場所に連れ出し、911に電話してください。",
  },
};

/**
 * The approved lines for what was detected, in `lang`. Medical, flood,
 * electrical and general emergencies have NO scripted advice on purpose: they
 * are escalated to a person and the caller is told to call 911 for medical
 * danger by the human, not improvised by the interpreter.
 */
export function safetyLines(kinds: EmergencyKind[], lang: InterpLang): string[] {
  const keys: SafetyKey[] = [];
  if (kinds.includes("gas")) keys.push("gas");
  if (kinds.includes("co")) keys.push("co");
  if (kinds.includes("fire")) keys.push("fire");
  return keys.map((k) => SAFETY_INSTRUCTIONS[k][lang]);
}
