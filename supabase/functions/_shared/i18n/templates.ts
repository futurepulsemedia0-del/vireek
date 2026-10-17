// supabase/functions/_shared/i18n/templates.ts
//
// Customer-facing message templates in all 9 supported languages, plus
// locale-correct money/date formatting. Used by invoice-email,
// create-payment-request, send-payment-reminders and the voice greeting.
//
// Design rules
//  - `Catalog` is typed Record<TemplateKey, Record<LanguageCode, string>>, so
//    adding a key or a language without translating it is a COMPILE error.
//  - Placeholders are single-brace `{name}`. templates.test.ts asserts every
//    language keeps exactly the same placeholders as English.
//  - Values are interpolated in ONE pass, so a customer name containing
//    "{url}" can never be expanded. Callers must HTML-escape values they put
//    into HTML (see `renderTemplate(..., { escape: escapeHtml })`).

import { DEFAULT_LANGUAGE, intlLocale, languageDirection, normalizeLanguage, type LanguageCode } from "./languages.ts";

type Entry = Record<LanguageCode, string>;

export const CATALOG = {
  "payment.sms.ready": {
    en: "Hi {name}, your invoice for {amount} is ready. Pay securely: {url}",
    es: "Hola {name}, su factura por {amount} está lista. Pague de forma segura: {url}",
    zh: "{name}，您好，您的 {amount} 账单已生成。请通过安全链接付款：{url}",
    hi: "नमस्ते {name}, आपका {amount} का इनवॉइस तैयार है। यहाँ सुरक्षित रूप से भुगतान करें: {url}",
    fr: "Bonjour {name}, votre facture de {amount} est prête. Payez en toute sécurité : {url}",
    de: "Hallo {name}, Ihre Rechnung über {amount} ist fertig. Sicher bezahlen: {url}",
    ar: "مرحباً {name}، فاتورتك بمبلغ {amount} جاهزة. ادفع بأمان عبر الرابط: {url}",
    fa: "سلام {name}، فاکتور شما به مبلغ {amount} آماده است. پرداخت امن: {url}",
    ja: "{name}様、{amount}の請求書をご用意しました。こちらから安全にお支払いください：{url}",
  },
  "payment.sms.reminder": {
    en: "Reminder: your {amount} invoice is still open. Pay here: {url}",
    es: "Recordatorio: su factura de {amount} sigue pendiente. Pague aquí: {url}",
    zh: "提醒：您的 {amount} 账单仍未付款。付款链接：{url}",
    hi: "अनुस्मारक: आपका {amount} का इनवॉइस अभी भी बकाया है। यहाँ भुगतान करें: {url}",
    fr: "Rappel : votre facture de {amount} est toujours impayée. Payez ici : {url}",
    de: "Erinnerung: Ihre Rechnung über {amount} ist noch offen. Hier bezahlen: {url}",
    ar: "تذكير: فاتورتك بمبلغ {amount} لا تزال مستحقة الدفع. ادفع هنا: {url}",
    fa: "یادآوری: فاکتور {amount} شما هنوز پرداخت نشده است. پرداخت: {url}",
    ja: "リマインダー：{amount}の請求書は未払いです。お支払いはこちら：{url}",
  },
  "payment.email.ready.subject": {
    en: "Your {amount} invoice is ready",
    es: "Su factura de {amount} está lista",
    zh: "您的 {amount} 账单已生成",
    hi: "आपका {amount} का इनवॉइस तैयार है",
    fr: "Votre facture de {amount} est prête",
    de: "Ihre Rechnung über {amount} ist fertig",
    ar: "فاتورتك بمبلغ {amount} جاهزة",
    fa: "فاکتور {amount} شما آماده است",
    ja: "{amount}の請求書をご用意しました",
  },
  "payment.email.ready.eyebrow": {
    en: "Invoice ready",
    es: "Factura lista",
    zh: "账单已生成",
    hi: "इनवॉइस तैयार",
    fr: "Facture prête",
    de: "Rechnung bereit",
    ar: "الفاتورة جاهزة",
    fa: "فاکتور آماده است",
    ja: "請求書のご案内",
  },
  "payment.email.ready.heading": {
    en: "{amount} due for {description}",
    es: "{amount} por pagar: {description}",
    zh: "{description} 应付 {amount}",
    hi: "{description} के लिए {amount} देय",
    fr: "{amount} à régler pour {description}",
    de: "{amount} fällig für {description}",
    ar: "المبلغ المستحق {amount} مقابل {description}",
    fa: "مبلغ {amount} بابت {description} قابل پرداخت است",
    ja: "{description}のお支払い額：{amount}",
  },
  "payment.email.ready.cta": {
    en: "Pay {amount} now",
    es: "Pagar {amount} ahora",
    zh: "立即支付 {amount}",
    hi: "अभी {amount} का भुगतान करें",
    fr: "Payer {amount} maintenant",
    de: "{amount} jetzt bezahlen",
    ar: "ادفع {amount} الآن",
    fa: "پرداخت {amount}",
    ja: "{amount}を今すぐ支払う",
  },
  "payment.email.ready.footer": {
    en: "Secure payment powered by Stripe.",
    es: "Pago seguro con tecnología de Stripe.",
    zh: "由 Stripe 提供安全支付。",
    hi: "Stripe द्वारा संचालित सुरक्षित भुगतान।",
    fr: "Paiement sécurisé par Stripe.",
    de: "Sichere Zahlung über Stripe.",
    ar: "دفع آمن عبر Stripe.",
    fa: "پرداخت امن با Stripe.",
    ja: "Stripeによる安全なお支払い。",
  },
  "payment.email.ready.text": {
    en: "{amount} due for {description}. Pay securely: {url}",
    es: "{amount} por pagar: {description}. Pague de forma segura: {url}",
    zh: "{description} 应付 {amount}。安全付款：{url}",
    hi: "{description} के लिए {amount} देय। सुरक्षित भुगतान: {url}",
    fr: "{amount} à régler pour {description}. Payez en toute sécurité : {url}",
    de: "{amount} fällig für {description}. Sicher bezahlen: {url}",
    ar: "المبلغ المستحق {amount} مقابل {description}. ادفع بأمان: {url}",
    fa: "مبلغ {amount} بابت {description} قابل پرداخت است. پرداخت امن: {url}",
    ja: "{description}のお支払い額：{amount}。安全なお支払い：{url}",
  },
  "payment.email.reminder.subject": {
    en: "Reminder: {amount} invoice still open",
    es: "Recordatorio: su factura de {amount} sigue pendiente",
    zh: "提醒：{amount} 账单仍未付款",
    hi: "अनुस्मारक: {amount} का इनवॉइस अभी भी बकाया है",
    fr: "Rappel : facture de {amount} toujours impayée",
    de: "Erinnerung: Rechnung über {amount} noch offen",
    ar: "تذكير: فاتورة {amount} لا تزال مستحقة",
    fa: "یادآوری: فاکتور {amount} هنوز پرداخت نشده است",
    ja: "リマインダー：{amount}の請求書が未払いです",
  },
  "payment.email.reminder.body": {
    en: "Hi {name}, a friendly reminder that your {amount} invoice hasn't been paid yet.",
    es: "Hola {name}, le recordamos amablemente que su factura de {amount} aún no ha sido pagada.",
    zh: "{name}，您好，温馨提醒：您的 {amount} 账单尚未付款。",
    hi: "नमस्ते {name}, यह एक विनम्र अनुस्मारक है कि आपका {amount} का इनवॉइस अभी तक चुकाया नहीं गया है।",
    fr: "Bonjour {name}, petit rappel : votre facture de {amount} n'a pas encore été réglée.",
    de: "Hallo {name}, zur Erinnerung: Ihre Rechnung über {amount} wurde noch nicht bezahlt.",
    ar: "مرحباً {name}، نذكّرك بلطف بأن فاتورتك بمبلغ {amount} لم تُسدَّد بعد.",
    fa: "سلام {name}، یادآوری دوستانه: فاکتور {amount} شما هنوز پرداخت نشده است.",
    ja: "{name}様、{amount}の請求書がまだお支払いいただけていないことをお知らせいたします。",
  },
  "invoice.email.subject.initial": {
    en: "Invoice {number} from {business}",
    es: "Factura {number} de {business}",
    zh: "{business} 的账单 {number}",
    hi: "{business} की ओर से इनवॉइस {number}",
    fr: "Facture {number} de {business}",
    de: "Rechnung {number} von {business}",
    ar: "فاتورة {number} من {business}",
    fa: "فاکتور {number} از {business}",
    ja: "{business}からの請求書 {number}",
  },
  "invoice.email.subject.reminder": {
    en: "Reminder: invoice {number} from {business}",
    es: "Recordatorio: factura {number} de {business}",
    zh: "提醒：{business} 的账单 {number}",
    hi: "अनुस्मारक: {business} की ओर से इनवॉइस {number}",
    fr: "Rappel : facture {number} de {business}",
    de: "Erinnerung: Rechnung {number} von {business}",
    ar: "تذكير: فاتورة {number} من {business}",
    fa: "یادآوری: فاکتور {number} از {business}",
    ja: "リマインダー：{business}からの請求書 {number}",
  },
  "invoice.email.subject.overdue": {
    en: "Overdue: invoice {number} from {business}",
    es: "Vencida: factura {number} de {business}",
    zh: "已逾期：{business} 的账单 {number}",
    hi: "विलंबित: {business} की ओर से इनवॉइस {number}",
    fr: "En retard : facture {number} de {business}",
    de: "Überfällig: Rechnung {number} von {business}",
    ar: "متأخرة: فاتورة {number} من {business}",
    fa: "سررسید گذشته: فاکتور {number} از {business}",
    ja: "お支払い期限超過：{business}からの請求書 {number}",
  },
  "invoice.email.greeting": {
    en: "Hi {name},",
    es: "Hola {name},",
    zh: "{name}，您好：",
    hi: "नमस्ते {name},",
    fr: "Bonjour {name},",
    de: "Hallo {name},",
    ar: "مرحباً {name}،",
    fa: "سلام {name}،",
    ja: "{name}様",
  },
  "invoice.email.lead.initial": {
    en: "Your invoice is ready.",
    es: "Su factura está lista.",
    zh: "您的账单已生成。",
    hi: "आपका इनवॉइस तैयार है।",
    fr: "Votre facture est prête.",
    de: "Ihre Rechnung ist fertig.",
    ar: "فاتورتك جاهزة.",
    fa: "فاکتور شما آماده است.",
    ja: "請求書をご用意しました。",
  },
  "invoice.email.lead.reminder": {
    en: "This is a friendly reminder that the invoice below is still open.",
    es: "Le recordamos amablemente que la factura siguiente sigue pendiente.",
    zh: "温馨提醒：以下账单仍未结清。",
    hi: "यह एक विनम्र अनुस्मारक है कि नीचे दिया गया इनवॉइस अभी भी बकाया है।",
    fr: "Petit rappel : la facture ci-dessous est toujours ouverte.",
    de: "Zur Erinnerung: Die untenstehende Rechnung ist noch offen.",
    ar: "نذكّرك بلطف بأن الفاتورة أدناه لا تزال مفتوحة.",
    fa: "یادآوری دوستانه: فاکتور زیر هنوز تسویه نشده است.",
    ja: "下記の請求書が未払いのままとなっておりますのでご案内いたします。",
  },
  "invoice.email.label.invoice": {
    en: "Invoice",
    es: "Factura",
    zh: "账单",
    hi: "इनवॉइस",
    fr: "Facture",
    de: "Rechnung",
    ar: "الفاتورة",
    fa: "فاکتور",
    ja: "請求書",
  },
  "invoice.email.label.balance": {
    en: "Balance due",
    es: "Saldo pendiente",
    zh: "应付余额",
    hi: "देय शेष राशि",
    fr: "Solde à payer",
    de: "Offener Betrag",
    ar: "الرصيد المستحق",
    fa: "مانده قابل پرداخت",
    ja: "お支払い残高",
  },
  "invoice.email.due": {
    en: "Due {date}.",
    es: "Vence el {date}.",
    zh: "到期日：{date}。",
    hi: "देय तिथि: {date}।",
    fr: "À régler avant le {date}.",
    de: "Fällig am {date}.",
    ar: "تاريخ الاستحقاق: {date}.",
    fa: "سررسید: {date}.",
    ja: "お支払い期限：{date}",
  },
  "invoice.email.cta": {
    en: "View invoice",
    es: "Ver factura",
    zh: "查看账单",
    hi: "इनवॉइस देखें",
    fr: "Voir la facture",
    de: "Rechnung ansehen",
    ar: "عرض الفاتورة",
    fa: "مشاهده فاکتور",
    ja: "請求書を見る",
  },
  "invoice.email.viewHere": {
    en: "View it here:",
    es: "Véala aquí:",
    zh: "查看链接：",
    hi: "यहाँ देखें:",
    fr: "Consultez-la ici :",
    de: "Hier ansehen:",
    ar: "اعرضها هنا:",
    fa: "مشاهده در اینجا:",
    ja: "こちらからご確認ください：",
  },
  "invoice.email.signoff": {
    en: "Thank you,",
    es: "Gracias,",
    zh: "谢谢！",
    hi: "धन्यवाद,",
    fr: "Merci,",
    de: "Vielen Dank,",
    ar: "شكراً لك،",
    fa: "با تشکر،",
    ja: "よろしくお願いいたします。",
  },
  "invoice.email.fallbackBusiness": {
    en: "Your service provider",
    es: "Su proveedor de servicios",
    zh: "您的服务商",
    hi: "आपका सेवा प्रदाता",
    fr: "Votre prestataire de services",
    de: "Ihr Dienstleister",
    ar: "مزوّد الخدمة الخاص بك",
    fa: "ارائه‌دهنده خدمات شما",
    ja: "サービス提供会社",
  },
  "voice.firstMessage": {
    en: "Hello, thanks for calling {business}. This is {assistant}. How can I help you today?",
    es: "Hola, gracias por llamar a {business}. Habla {assistant}. ¿En qué puedo ayudarle hoy?",
    zh: "您好，感谢致电 {business}。我是{assistant}。请问有什么可以帮您？",
    hi: "नमस्ते, {business} को कॉल करने के लिए धन्यवाद। मैं {assistant} हूँ। बताइए, आपकी क्या सहायता करूँ?",
    fr: "Bonjour, merci d'avoir appelé {business}. Je suis {assistant}. Comment puis-je vous aider ?",
    de: "Hallo, vielen Dank für Ihren Anruf bei {business}. Hier ist {assistant}. Wie kann ich Ihnen helfen?",
    ar: "مرحباً، شكراً لاتصالك بـ {business}. معك {assistant}. كيف يمكنني مساعدتك اليوم؟",
    fa: "سلام، از تماس شما با {business} متشکرم. من {assistant} هستم. چطور می‌توانم کمکتان کنم؟",
    ja: "お電話ありがとうございます。{business}の{assistant}です。本日はどのようなご用件でしょうか？",
  },
  "voice.assistantFallback": {
    en: "your virtual assistant",
    es: "su asistente virtual",
    zh: "智能助理",
    hi: "आपका वर्चुअल सहायक",
    fr: "votre assistant virtuel",
    de: "Ihr virtueller Assistent",
    ar: "مساعدك الافتراضي",
    fa: "دستیار مجازی شما",
    ja: "AIアシスタント",
  },
} satisfies Record<string, Entry>;

export type TemplateKey = keyof typeof CATALOG;

export type TemplateVars = Record<string, string | number | null | undefined>;

export interface RenderOptions {
  /** Applied to every interpolated VALUE (not to the template text). Use escapeHtml for HTML bodies. */
  escape?: (value: string) => string;
}

/** Renders `key` in `language` (falls back to English if the code is unknown). */
export function renderTemplate(
  key: TemplateKey,
  language: LanguageCode | string | null | undefined,
  vars: TemplateVars = {},
  options: RenderOptions = {},
): string {
  const lang = normalizeLanguage(language) ?? DEFAULT_LANGUAGE;
  const entry = CATALOG[key] as Entry;
  const template = entry[lang] ?? entry[DEFAULT_LANGUAGE];
  const esc = options.escape;
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === null || v === undefined) return "";
    const s = String(v);
    return esc ? esc(s) : s;
  });
}

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** `lang="fa" dir="rtl"` for the root element of an HTML email. */
export function htmlLangAttrs(language: LanguageCode | string | null | undefined): string {
  const lang = normalizeLanguage(language) ?? DEFAULT_LANGUAGE;
  return `lang="${lang}" dir="${languageDirection(lang)}"`;
}

/** "text-align" that follows reading direction, for inline-styled email HTML. */
export function textAlignStart(language: LanguageCode | string | null | undefined): "left" | "right" {
  const lang = normalizeLanguage(language) ?? DEFAULT_LANGUAGE;
  return languageDirection(lang) === "rtl" ? "right" : "left";
}

/** Money in the customer's language (Latin digits, Gregorian). `amount` is in major units (dollars). */
export function formatMoney(amount: number, language: LanguageCode | string | null | undefined, currency = "USD"): string {
  const lang = normalizeLanguage(language) ?? DEFAULT_LANGUAGE;
  const value = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat(intlLocale(lang), { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/**
 * Date-only strings ("2026-10-20") are formatted in UTC so the calendar day
 * never shifts with the server's time zone.
 */
export function formatDate(value: string | Date, language: LanguageCode | string | null | undefined): string {
  const lang = normalizeLanguage(language) ?? DEFAULT_LANGUAGE;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(intlLocale(lang), { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(d);
}
