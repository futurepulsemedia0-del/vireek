// supabase/functions/_shared/interpreter/languages.ts
//
// Languages the live interpreter can work in, and every fixed phrase it ever
// speaks. Pure TypeScript (no Deno / browser APIs) so Edge Functions, the
// bridge worker and the React app all import this one file.
//
// Relationship to ../i18n/languages.ts: that module owns the CUSTOMER DOCUMENT
// languages (invoices, SMS, portal) and is deliberately left untouched. This
// one is a superset (adds Portuguese and Vietnamese) because interpreting
// needs no translated invoice catalogue. `Phrases` is a Record over every
// InterpLang, so adding a language without all its phrases is a compile error.
//
// Every phrase here is spoken to a real caller. They are fixed, reviewed text
// and are never produced by a model. `reviewed: false` means no native-speaker
// sign-off is recorded yet; readiness.ts keeps such a language at Beta.

export const NON_ENGLISH = ["es", "pt", "vi", "zh", "ar", "fa", "hi", "fr", "de", "ja"] as const;
export type NonEnglish = (typeof NON_ENGLISH)[number];
export type InterpLang = "en" | NonEnglish;
export const INTERP_LANGUAGES: readonly InterpLang[] = ["en", ...NON_ENGLISH];

export function isInterpLang(v: unknown): v is InterpLang {
  return typeof v === "string" && (INTERP_LANGUAGES as readonly string[]).includes(v);
}

/** "pt-BR" / "ES" / "zh_CN" -> InterpLang or null. Never throws. */
export function normalizeInterpLang(raw: unknown): InterpLang | null {
  if (typeof raw !== "string") return null;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return isInterpLang(base) ? base : null;
}

export interface InterpMeta {
  name: string;
  nativeName: string;
  dir: "ltr" | "rtl";
  /** Streaming-ASR language tag (Deepgram nova-3 naming). */
  asr: string;
  /** TTS locale tag. */
  tts: string;
  /** CJK-style text: no spaces between words (affects WER -> CER and short-utterance rules). */
  noSpaces: boolean;
}

export const INTERP_META: Record<InterpLang, InterpMeta> = {
  en: { name: "English", nativeName: "English", dir: "ltr", asr: "en-US", tts: "en-US", noSpaces: false },
  es: { name: "Spanish", nativeName: "Español", dir: "ltr", asr: "es-419", tts: "es-US", noSpaces: false },
  pt: { name: "Portuguese", nativeName: "Português", dir: "ltr", asr: "pt-BR", tts: "pt-BR", noSpaces: false },
  vi: { name: "Vietnamese", nativeName: "Tiếng Việt", dir: "ltr", asr: "vi", tts: "vi-VN", noSpaces: false },
  zh: { name: "Mandarin Chinese", nativeName: "中文（普通话）", dir: "ltr", asr: "zh-CN", tts: "zh-CN", noSpaces: true },
  ar: { name: "Arabic", nativeName: "العربية", dir: "rtl", asr: "ar", tts: "ar", noSpaces: false },
  fa: { name: "Persian (Farsi)", nativeName: "فارسی", dir: "rtl", asr: "fa", tts: "fa-IR", noSpaces: false },
  hi: { name: "Hindi", nativeName: "हिन्दी", dir: "ltr", asr: "hi", tts: "hi-IN", noSpaces: false },
  fr: { name: "French", nativeName: "Français", dir: "ltr", asr: "fr", tts: "fr-FR", noSpaces: false },
  de: { name: "German", nativeName: "Deutsch", dir: "ltr", asr: "de", tts: "de-DE", noSpaces: false },
  ja: { name: "Japanese", nativeName: "日本語", dir: "ltr", asr: "ja", tts: "ja-JP", noSpaces: true },
};

export function interpLabel(l: InterpLang): string {
  const m = INTERP_META[l];
  return m.nativeName === m.name ? m.name : `${m.nativeName} (${m.name})`;
}

export interface Phrases {
  /** Spoken once at the start of interpretation, to that party, in their language. */
  aiDisclosure: string;
  /** "You can say 'English' at any time." */
  switchHint: string;
  /** Asks the caller to confirm a detected language. Placeholder: {language} (native name). */
  confirmLanguage: string;
  askRepeat: string;
  readbackIntro: string;
  readbackAsk: string;
  /** Spoken if the interpreter cannot continue reliably and a person takes over. */
  handoff: string;
  /** Placeholder: {language} (native name). */
  switchedTo: string;
  labels: { address: string; phone: string; time: string; amount: string; day: string; code: string };
}

export const PHRASES: Record<InterpLang, Phrases> = {
  en: {
    aiDisclosure: "Please note: I am an AI interpreter, not a person. I will translate for both of you. Please speak in short sentences and pause after each one.",
    switchHint: "You can say \"English\" at any time to switch.",
    confirmLanguage: "I heard {language}. Would you like to continue in {language}? Say yes, or say English.",
    askRepeat: "Sorry, I did not catch that. Could you please say it again?",
    readbackIntro: "Let me confirm what I understood.",
    readbackAsk: "Is that correct?",
    handoff: "I am having trouble understanding. I will connect you with a team member now.",
    switchedTo: "Okay, continuing in {language}.",
    labels: { address: "Address", phone: "Phone", time: "Time", amount: "Amount", day: "Day", code: "Model or code" },
  },
  es: {
    aiDisclosure: "Aviso: soy un intérprete de inteligencia artificial, no una persona. Voy a traducir para ambos. Por favor, hable en frases cortas y haga una pausa después de cada una.",
    switchHint: "Puede decir «inglés» en cualquier momento para cambiar.",
    confirmLanguage: "Le escuché hablar en {language}. ¿Desea continuar en {language}? Diga sí, o diga inglés.",
    askRepeat: "Perdón, no le entendí bien. ¿Puede repetirlo, por favor?",
    readbackIntro: "Permítame confirmar lo que entendí.",
    readbackAsk: "¿Es correcto?",
    handoff: "Tengo dificultad para entender. Lo comunico ahora con un miembro del equipo.",
    switchedTo: "De acuerdo, continuamos en {language}.",
    labels: { address: "Dirección", phone: "Teléfono", time: "Hora", amount: "Monto", day: "Día", code: "Modelo o código" },
  },
  pt: {
    aiDisclosure: "Aviso: sou um intérprete de inteligência artificial, não uma pessoa. Vou traduzir para os dois. Por favor, fale em frases curtas e faça uma pausa após cada uma.",
    switchHint: "Você pode dizer \"inglês\" a qualquer momento para mudar.",
    confirmLanguage: "Ouvi {language}. Deseja continuar em {language}? Diga sim, ou diga inglês.",
    askRepeat: "Desculpe, não entendi bem. Pode repetir, por favor?",
    readbackIntro: "Deixe-me confirmar o que entendi.",
    readbackAsk: "Está correto?",
    handoff: "Estou com dificuldade para entender. Vou transferir você agora para um membro da equipe.",
    switchedTo: "Certo, vamos continuar em {language}.",
    labels: { address: "Endereço", phone: "Telefone", time: "Horário", amount: "Valor", day: "Dia", code: "Modelo ou código" },
  },
  vi: {
    aiDisclosure: "Xin lưu ý: tôi là thông dịch viên trí tuệ nhân tạo, không phải người thật. Tôi sẽ phiên dịch cho cả hai bên. Xin hãy nói câu ngắn và dừng lại sau mỗi câu.",
    switchHint: "Bạn có thể nói \"tiếng Anh\" bất cứ lúc nào để chuyển.",
    confirmLanguage: "Tôi nghe bạn nói {language}. Bạn có muốn tiếp tục bằng {language} không? Hãy nói có, hoặc nói tiếng Anh.",
    askRepeat: "Xin lỗi, tôi chưa nghe rõ. Bạn vui lòng nói lại được không?",
    readbackIntro: "Để tôi xác nhận lại những gì tôi hiểu.",
    readbackAsk: "Có đúng không?",
    handoff: "Tôi đang gặp khó khăn khi nghe hiểu. Tôi sẽ chuyển bạn cho một nhân viên ngay bây giờ.",
    switchedTo: "Được, chúng ta tiếp tục bằng {language}.",
    labels: { address: "Địa chỉ", phone: "Số điện thoại", time: "Giờ", amount: "Số tiền", day: "Ngày", code: "Kiểu máy hoặc mã" },
  },
  zh: {
    aiDisclosure: "请注意：我是人工智能口译员，不是真人。我会为双方翻译。请说短句，每说完一句稍作停顿。",
    switchHint: "您可以随时说“英语”来切换。",
    confirmLanguage: "我听到您说的是{language}。是否继续使用{language}？请说“是”，或说“英语”。",
    askRepeat: "抱歉，我没听清楚。请您再说一遍好吗？",
    readbackIntro: "请允许我确认一下我听到的内容。",
    readbackAsk: "对吗？",
    handoff: "我听不太清楚，现在为您转接工作人员。",
    switchedTo: "好的，我们继续使用{language}。",
    labels: { address: "地址", phone: "电话", time: "时间", amount: "金额", day: "日期", code: "型号或编码" },
  },
  ar: {
    aiDisclosure: "تنبيه: أنا مترجم فوري يعمل بالذكاء الاصطناعي ولست شخصاً حقيقياً. سأترجم لكليكما. يرجى التحدث بجمل قصيرة والتوقف بعد كل جملة.",
    switchHint: "يمكنك قول «الإنجليزية» في أي وقت للتبديل.",
    confirmLanguage: "سمعتك تتحدث بـ{language}. هل تريد المتابعة بـ{language}؟ قل نعم، أو قل الإنجليزية.",
    askRepeat: "عذراً، لم أسمع جيداً. هل يمكنك التكرار من فضلك؟",
    readbackIntro: "اسمح لي بتأكيد ما فهمته.",
    readbackAsk: "هل هذا صحيح؟",
    handoff: "أواجه صعوبة في الفهم. سأحوّلك الآن إلى أحد أعضاء الفريق.",
    switchedTo: "حسناً، سنتابع بـ{language}.",
    labels: { address: "العنوان", phone: "الهاتف", time: "الوقت", amount: "المبلغ", day: "اليوم", code: "الطراز أو الرمز" },
  },
  fa: {
    aiDisclosure: "توجه: من یک مترجم هوش مصنوعی هستم، نه یک انسان. برای هر دوی شما ترجمه می‌کنم. لطفاً جمله‌های کوتاه بگویید و بعد از هر جمله کمی مکث کنید.",
    switchHint: "هر زمان بخواهید می‌توانید بگویید «انگلیسی» تا زبان عوض شود.",
    confirmLanguage: "شنیدم به {language} صحبت کردید. آیا می‌خواهید به {language} ادامه دهید؟ بگویید بله، یا بگویید انگلیسی.",
    askRepeat: "ببخشید، متوجه نشدم. لطفاً دوباره بگویید.",
    readbackIntro: "اجازه بدهید آنچه فهمیدم را تأیید کنم.",
    readbackAsk: "درست است؟",
    handoff: "در فهمیدن مشکل دارم. همین حالا شما را به یکی از اعضای تیم وصل می‌کنم.",
    switchedTo: "بسیار خب، به {language} ادامه می‌دهیم.",
    labels: { address: "آدرس", phone: "تلفن", time: "ساعت", amount: "مبلغ", day: "روز", code: "مدل یا کد" },
  },
  hi: {
    aiDisclosure: "ध्यान दें: मैं एक एआई दुभाषिया हूँ, कोई इंसान नहीं। मैं आप दोनों के लिए अनुवाद करूँगी। कृपया छोटे वाक्य बोलें और हर वाक्य के बाद रुकें।",
    switchHint: "आप कभी भी \"अंग्रेज़ी\" कहकर भाषा बदल सकते हैं।",
    confirmLanguage: "मैंने आपको {language} बोलते सुना। क्या आप {language} में जारी रखना चाहेंगे? हाँ कहें, या अंग्रेज़ी कहें।",
    askRepeat: "माफ़ कीजिए, मैं ठीक से सुन नहीं पाई। क्या आप दोबारा बोल सकते हैं?",
    readbackIntro: "मुझे जो समझ आया, उसकी पुष्टि कर लेने दीजिए।",
    readbackAsk: "क्या यह सही है?",
    handoff: "मुझे समझने में दिक्कत हो रही है। मैं अभी आपको टीम के एक सदस्य से जोड़ रही हूँ।",
    switchedTo: "ठीक है, हम {language} में जारी रखते हैं।",
    labels: { address: "पता", phone: "फ़ोन", time: "समय", amount: "राशि", day: "दिन", code: "मॉडल या कोड" },
  },
  fr: {
    aiDisclosure: "Veuillez noter : je suis un interprète à intelligence artificielle, et non une personne. Je vais traduire pour vous deux. Parlez par phrases courtes et faites une pause après chacune.",
    switchHint: "Vous pouvez dire « anglais » à tout moment pour changer.",
    confirmLanguage: "Je vous ai entendu parler en {language}. Souhaitez-vous continuer en {language} ? Dites oui, ou dites anglais.",
    askRepeat: "Désolé, je n'ai pas bien compris. Pouvez-vous répéter, s'il vous plaît ?",
    readbackIntro: "Permettez-moi de confirmer ce que j'ai compris.",
    readbackAsk: "Est-ce correct ?",
    handoff: "J'ai du mal à comprendre. Je vous mets en relation avec un membre de l'équipe.",
    switchedTo: "D'accord, nous continuons en {language}.",
    labels: { address: "Adresse", phone: "Téléphone", time: "Heure", amount: "Montant", day: "Jour", code: "Modèle ou code" },
  },
  de: {
    aiDisclosure: "Hinweis: Ich bin ein KI-Dolmetscher, keine reale Person. Ich übersetze für Sie beide. Bitte sprechen Sie in kurzen Sätzen und machen Sie nach jedem Satz eine Pause.",
    switchHint: "Sie können jederzeit „Englisch“ sagen, um zu wechseln.",
    confirmLanguage: "Ich habe {language} gehört. Möchten Sie auf {language} fortfahren? Sagen Sie ja, oder sagen Sie Englisch.",
    askRepeat: "Entschuldigung, das habe ich nicht verstanden. Können Sie es bitte wiederholen?",
    readbackIntro: "Ich bestätige kurz, was ich verstanden habe.",
    readbackAsk: "Ist das richtig?",
    handoff: "Ich habe Schwierigkeiten beim Verstehen. Ich verbinde Sie jetzt mit einem Teammitglied.",
    switchedTo: "In Ordnung, wir machen auf {language} weiter.",
    labels: { address: "Adresse", phone: "Telefon", time: "Uhrzeit", amount: "Betrag", day: "Tag", code: "Modell oder Code" },
  },
  ja: {
    aiDisclosure: "ご案内：私はAI通訳であり、人間ではありません。お二人のために通訳します。短い文で話し、一文ごとに間を置いてください。",
    switchHint: "いつでも「英語」と言えば切り替えられます。",
    confirmLanguage: "{language}でお話しになっていると聞こえました。{language}で続けますか？「はい」または「英語」とお答えください。",
    askRepeat: "申し訳ありません、聞き取れませんでした。もう一度お願いできますか？",
    readbackIntro: "理解した内容を確認させてください。",
    readbackAsk: "よろしいですか？",
    handoff: "聞き取りが難しいため、ただいまスタッフにおつなぎします。",
    switchedTo: "かしこまりました。{language}で続けます。",
    labels: { address: "住所", phone: "電話番号", time: "時間", amount: "金額", day: "日にち", code: "型番またはコード" },
  },
};

/** Fixed-template fill: single pass, so a value containing "{x}" is never expanded. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? values[k] : m));
}

export function confirmLanguagePrompt(lang: InterpLang): string {
  return fill(PHRASES[lang].confirmLanguage, { language: INTERP_META[lang].nativeName });
}

/** Both-sides disclosure for the bridge: the caller hears theirs, staff hear English. */
export function bridgeDisclosure(callerLang: InterpLang): { caller: string; staff: string } {
  const c = PHRASES[callerLang];
  const e = PHRASES.en;
  return {
    caller: `${c.aiDisclosure} ${c.switchHint}`,
    staff: `${e.aiDisclosure} ${e.switchHint}`,
  };
}

/** Natural default per-language greeting (business name + assistant name). Replaceable per business. */
export const DEFAULT_GREETINGS: Record<InterpLang, string> = {
  en: "Thank you for calling {business}. This is {assistant}. How can I help you today?",
  es: "Gracias por llamar a {business}. Habla {assistant}. ¿En qué puedo ayudarle hoy?",
  pt: "Obrigada por ligar para {business}. Aqui é {assistant}. Como posso ajudar hoje?",
  vi: "Cảm ơn bạn đã gọi {business}. Tôi là {assistant}. Hôm nay tôi có thể giúp gì cho bạn?",
  zh: "感谢致电{business}。我是{assistant}。请问今天有什么可以帮您？",
  ar: "شكراً لاتصالك بـ{business}. معك {assistant}. كيف يمكنني مساعدتك اليوم؟",
  fa: "از تماس شما با {business} متشکرم. من {assistant} هستم. امروز چطور می‌توانم کمکتان کنم؟",
  hi: "{business} को कॉल करने के लिए धन्यवाद। मैं {assistant} बोल रही हूँ। आज मैं आपकी कैसे मदद कर सकती हूँ?",
  fr: "Merci d'avoir appelé {business}. Ici {assistant}. Comment puis-je vous aider aujourd'hui ?",
  de: "Danke für Ihren Anruf bei {business}. Hier ist {assistant}. Wie kann ich Ihnen heute helfen?",
  ja: "{business}にお電話いただきありがとうございます。{assistant}です。本日はどのようなご用件でしょうか？",
};

/** Per-language reviewer sign-off for the fixed phrases and safety text. Empty until a native speaker signs off. */
export const PHRASE_REVIEW: Record<InterpLang, { reviewedBy: string | null; reviewedAt: string | null }> = {
  en: { reviewedBy: "vireek-team", reviewedAt: null },
  es: { reviewedBy: null, reviewedAt: null },
  pt: { reviewedBy: null, reviewedAt: null },
  vi: { reviewedBy: null, reviewedAt: null },
  zh: { reviewedBy: null, reviewedAt: null },
  ar: { reviewedBy: null, reviewedAt: null },
  fa: { reviewedBy: null, reviewedAt: null },
  hi: { reviewedBy: null, reviewedAt: null },
  fr: { reviewedBy: null, reviewedAt: null },
  de: { reviewedBy: null, reviewedAt: null },
  ja: { reviewedBy: null, reviewedAt: null },
};
