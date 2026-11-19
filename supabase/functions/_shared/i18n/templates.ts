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
  "billing.renewal.subject": {
    en: "Your Vireek {plan} plan renews on {date}",
    es: "Su plan {plan} de Vireek se renueva el {date}",
    zh: "您的 Vireek {plan} 套餐将于 {date} 续订",
    hi: "आपका Vireek {plan} प्लान {date} को रिन्यू होगा",
    fr: "Votre forfait Vireek {plan} est renouvelé le {date}",
    de: "Ihr Vireek-Tarif {plan} verlängert sich am {date}",
    ar: "تتجدد باقة Vireek {plan} الخاصة بك في {date}",
    fa: "طرح {plan} Vireek شما در {date} تمدید می‌شود",
    ja: "Vireek {plan}プランは{date}に更新されます",
  },
  "billing.renewal.body": {
    en: "Hi {name}, your annual Vireek {plan} plan renews automatically on {date}. Your payment method on file will be charged {amount}. Your plan includes {minutes} minutes per month.\nTo change your plan or cancel before it renews, open your billing settings.",
    es: "Hola {name}, su plan anual {plan} de Vireek se renueva automáticamente el {date}. Se cobrará {amount} al método de pago registrado. Su plan incluye {minutes} minutos al mes.\nPara cambiar de plan o cancelar antes de la renovación, abra la configuración de facturación.",
    zh: "{name}，您好，您的 Vireek {plan} 年度套餐将于 {date} 自动续订。我们将从您预留的付款方式扣款 {amount}。该套餐每月包含 {minutes} 分钟。\n如需在续订前更改套餐或取消，请打开账单设置。",
    hi: "नमस्ते {name}, आपका वार्षिक Vireek {plan} प्लान {date} को अपने-आप रिन्यू हो जाएगा। आपकी सहेजी गई भुगतान विधि से {amount} लिए जाएँगे। आपके प्लान में हर महीने {minutes} मिनट शामिल हैं।\nरिन्यू होने से पहले प्लान बदलने या रद्द करने के लिए बिलिंग सेटिंग खोलें।",
    fr: "Bonjour {name}, votre forfait annuel Vireek {plan} sera renouvelé automatiquement le {date}. Votre moyen de paiement enregistré sera débité de {amount}. Votre forfait inclut {minutes} minutes par mois.\nPour changer de forfait ou résilier avant le renouvellement, ouvrez vos paramètres de facturation.",
    de: "Hallo {name}, Ihr jährlicher Vireek-Tarif {plan} verlängert sich am {date} automatisch. Ihre hinterlegte Zahlungsmethode wird mit {amount} belastet. Ihr Tarif enthält {minutes} Minuten pro Monat.\nUm den Tarif zu ändern oder vor der Verlängerung zu kündigen, öffnen Sie Ihre Abrechnungseinstellungen.",
    ar: "مرحباً {name}، ستتجدد باقتك السنوية Vireek {plan} تلقائياً في {date}. سيتم خصم {amount} من وسيلة الدفع المحفوظة لديك. تشمل باقتك {minutes} دقيقة شهرياً.\nلتغيير الباقة أو إلغائها قبل التجديد، افتح إعدادات الفوترة.",
    fa: "سلام {name}، طرح سالانه {plan} Vireek شما در {date} به‌صورت خودکار تمدید می‌شود. مبلغ {amount} از روش پرداخت ثبت‌شده شما کسر خواهد شد. طرح شما ماهانه {minutes} دقیقه شامل می‌شود.\nبرای تغییر طرح یا لغو پیش از تمدید، تنظیمات صورتحساب را باز کنید.",
    ja: "{name}様、Vireek {plan}の年間プランは{date}に自動更新されます。登録済みのお支払い方法に{amount}が請求されます。プランには毎月{minutes}分が含まれます。\n更新前にプランの変更や解約をする場合は、請求設定を開いてください。",
  },
"billing.interval.month": {
    en: "month",
    es: "mes",
    zh: "月",
    hi: "माह",
    fr: "mois",
    de: "Monat",
    ar: "شهر",
    fa: "ماه",
    ja: "か月",
  },
  "billing.interval.year": {
    en: "year",
    es: "año",
    zh: "年",
    hi: "वर्ष",
    fr: "an",
    de: "Jahr",
    ar: "سنة",
    fa: "سال",
    ja: "年",
  },
  "billing.notice.cta_cancel": {
    en: "Cancel your subscription",
    es: "Cancelar su suscripción",
    zh: "取消订阅",
    hi: "सदस्यता रद्द करें",
    fr: "Résilier votre abonnement",
    de: "Abonnement kündigen",
    ar: "إلغاء اشتراكك",
    fa: "لغو اشتراک",
    ja: "サブスクリプションを解約",
  },
  "billing.started.subject": {
    en: "Your Vireek {plan} plan is confirmed",
    es: "Su plan {plan} de Vireek está confirmado",
    zh: "您的 Vireek {plan} 套餐已确认",
    hi: "आपका Vireek {plan} प्लान कन्फ़र्म हो गया है",
    fr: "Votre forfait Vireek {plan} est confirmé",
    de: "Ihr Vireek-Tarif {plan} ist bestätigt",
    ar: "تم تأكيد باقة Vireek {plan} الخاصة بك",
    fa: "طرح {plan} Vireek شما تأیید شد",
    ja: "Vireek {plan}プランのご契約を確認しました",
  },
  "billing.started.body": {
    en: "Hi {name}, thanks for subscribing to the Vireek {plan} plan.\nYour plan costs {amount} per {interval}. It renews automatically on {date}, and then every {interval}, until you cancel. Each renewal is charged to your payment method on file.\nYou can cancel any time from your billing settings. Cancelling stops future renewals, and you keep access until the end of the period you have already paid for.\nPlease keep this email for your records.",
    es: "Hola {name}, gracias por suscribirse al plan {plan} de Vireek.\nSu plan cuesta {amount} al {interval}. Se renueva automáticamente el {date} y después cada {interval}, hasta que lo cancele. Cada renovación se cobra al método de pago registrado.\nPuede cancelar en cualquier momento desde la configuración de facturación. Al cancelar se detienen las renovaciones futuras y conserva el acceso hasta el final del período ya pagado.\nConserve este correo para sus registros.",
    zh: "{name}，您好，感谢您订阅 Vireek {plan} 套餐。\n套餐价格为每{interval} {amount}。套餐将于 {date} 自动续订，此后每{interval}续订一次，直至您取消。每次续订都会从您预留的付款方式扣款。\n您可以随时在账单设置中取消。取消后将不再续订，您仍可使用服务直至已付费周期结束。\n请保留此邮件作为记录。",
    hi: "नमस्ते {name}, Vireek {plan} प्लान की सदस्यता लेने के लिए धन्यवाद।\nआपके प्लान की कीमत प्रति {interval} {amount} है। यह {date} को अपने-आप रिन्यू होगा और उसके बाद हर {interval} रिन्यू होता रहेगा, जब तक आप रद्द नहीं करते। हर रिन्यूअल पर आपकी सहेजी गई भुगतान विधि से शुल्क लिया जाएगा।\nआप बिलिंग सेटिंग से कभी भी रद्द कर सकते हैं। रद्द करने पर आगे के रिन्यूअल रुक जाते हैं और आप पहले से भुगतान की गई अवधि के अंत तक एक्सेस बनाए रखते हैं।\nकृपया इस ईमेल को अपने रिकॉर्ड के लिए सहेज लें।",
    fr: "Bonjour {name}, merci d'avoir souscrit au forfait Vireek {plan}.\nVotre forfait coûte {amount} par {interval}. Il est renouvelé automatiquement le {date}, puis chaque {interval}, jusqu'à ce que vous le résiliiez. Chaque renouvellement est débité sur votre moyen de paiement enregistré.\nVous pouvez résilier à tout moment depuis vos paramètres de facturation. La résiliation met fin aux renouvellements futurs et vous conservez l'accès jusqu'à la fin de la période déjà payée.\nConservez cet e-mail pour vos dossiers.",
    de: "Hallo {name}, vielen Dank für Ihr Abonnement des Vireek-Tarifs {plan}.\nIhr Tarif kostet {amount} pro {interval}. Er verlängert sich am {date} automatisch und danach jeden {interval}, bis Sie kündigen. Jede Verlängerung wird Ihrer hinterlegten Zahlungsmethode belastet.\nSie können jederzeit in Ihren Abrechnungseinstellungen kündigen. Die Kündigung beendet künftige Verlängerungen, und Sie behalten den Zugang bis zum Ende des bereits bezahlten Zeitraums.\nBitte bewahren Sie diese E-Mail für Ihre Unterlagen auf.",
    ar: "مرحباً {name}، شكراً لاشتراكك في باقة Vireek {plan}.\nتبلغ تكلفة باقتك {amount} لكل {interval}. تتجدد تلقائياً في {date} ثم كل {interval} حتى تقوم بالإلغاء. يتم خصم كل تجديد من وسيلة الدفع المحفوظة لديك.\nيمكنك الإلغاء في أي وقت من إعدادات الفوترة. يوقف الإلغاء التجديدات المستقبلية، وتحتفظ بإمكانية الوصول حتى نهاية الفترة المدفوعة بالفعل.\nيرجى الاحتفاظ بهذه الرسالة في سجلاتك.",
    fa: "سلام {name}، از اشتراک شما در طرح {plan} Vireek سپاسگزاریم.\nهزینهٔ طرح شما {amount} در هر {interval} است. این طرح در {date} و پس از آن در هر {interval} به‌صورت خودکار تمدید می‌شود، تا زمانی که لغو کنید. هر تمدید از روش پرداخت ثبت‌شدهٔ شما کسر می‌شود.\nهر زمان بخواهید می‌توانید از تنظیمات صورتحساب لغو کنید. لغو، تمدیدهای بعدی را متوقف می‌کند و تا پایان دورهٔ پرداخت‌شده به سرویس دسترسی دارید.\nلطفاً این ایمیل را برای سوابق خود نگه دارید.",
    ja: "{name}様、Vireek {plan}プランをご契約いただきありがとうございます。\nプラン料金は1{interval}あたり{amount}です。{date}に自動更新され、その後も解約されるまで1{interval}ごとに更新されます。更新のたびに、登録済みのお支払い方法に請求されます。\n請求設定からいつでも解約できます。解約すると以降の更新は行われず、すでにお支払い済みの期間の終了までご利用いただけます。\nこのメールは記録として保管してください。",
  },
  "billing.started.trial_body": {
    en: "Hi {name}, your free trial of the Vireek {plan} plan has started.\nIf you don't cancel before {date}, your payment method on file will be charged {amount} on that date. Your plan then renews automatically every {interval} at that price until you cancel.\nYou can cancel any time before {date} from your billing settings and you will not be charged.\nPlease keep this email for your records.",
    es: "Hola {name}, ha comenzado su prueba gratuita del plan {plan} de Vireek.\nSi no cancela antes del {date}, se cobrarán {amount} al método de pago registrado en esa fecha. Después, su plan se renueva automáticamente cada {interval} a ese precio, hasta que lo cancele.\nPuede cancelar en cualquier momento antes del {date} desde la configuración de facturación y no se le cobrará.\nConserve este correo para sus registros.",
    zh: "{name}，您好，您的 Vireek {plan} 套餐免费试用已开始。\n如果您未在 {date} 之前取消，我们将在该日期从您预留的付款方式扣款 {amount}。此后套餐将按该价格每{interval}自动续订，直至您取消。\n您可以在 {date} 之前随时在账单设置中取消，不会产生任何扣款。\n请保留此邮件作为记录。",
    hi: "नमस्ते {name}, आपका Vireek {plan} प्लान का निःशुल्क ट्रायल शुरू हो गया है।\nयदि आप {date} से पहले रद्द नहीं करते, तो उसी तारीख को आपकी सहेजी गई भुगतान विधि से {amount} लिए जाएँगे। इसके बाद आपका प्लान इसी कीमत पर हर {interval} अपने-आप रिन्यू होता रहेगा, जब तक आप रद्द नहीं करते।\nआप {date} से पहले कभी भी बिलिंग सेटिंग से रद्द कर सकते हैं और आपसे कोई शुल्क नहीं लिया जाएगा।\nकृपया इस ईमेल को अपने रिकॉर्ड के लिए सहेज लें।",
    fr: "Bonjour {name}, votre essai gratuit du forfait Vireek {plan} a commencé.\nSi vous ne résiliez pas avant le {date}, votre moyen de paiement enregistré sera débité de {amount} à cette date. Votre forfait est ensuite renouvelé automatiquement chaque {interval} à ce tarif, jusqu'à ce que vous le résiliiez.\nVous pouvez résilier à tout moment avant le {date} depuis vos paramètres de facturation, sans aucun débit.\nConservez cet e-mail pour vos dossiers.",
    de: "Hallo {name}, Ihre kostenlose Testphase des Vireek-Tarifs {plan} hat begonnen.\nWenn Sie nicht vor dem {date} kündigen, wird Ihrer hinterlegten Zahlungsmethode an diesem Tag {amount} belastet. Danach verlängert sich Ihr Tarif automatisch jeden {interval} zu diesem Preis, bis Sie kündigen.\nSie können jederzeit vor dem {date} in Ihren Abrechnungseinstellungen kündigen und es wird nichts abgebucht.\nBitte bewahren Sie diese E-Mail für Ihre Unterlagen auf.",
    ar: "مرحباً {name}، بدأت تجربتك المجانية لباقة Vireek {plan}.\nإذا لم تقم بالإلغاء قبل {date}، فسيتم خصم {amount} من وسيلة الدفع المحفوظة لديك في ذلك التاريخ. بعد ذلك تتجدد باقتك تلقائياً كل {interval} بالسعر نفسه حتى تقوم بالإلغاء.\nيمكنك الإلغاء في أي وقت قبل {date} من إعدادات الفوترة ولن يتم خصم أي مبلغ.\nيرجى الاحتفاظ بهذه الرسالة في سجلاتك.",
    fa: "سلام {name}، دورهٔ آزمایشی رایگان طرح {plan} Vireek شما آغاز شد.\nاگر پیش از {date} لغو نکنید، در همان تاریخ مبلغ {amount} از روش پرداخت ثبت‌شدهٔ شما کسر می‌شود. پس از آن طرح شما با همین قیمت در هر {interval} به‌صورت خودکار تمدید می‌شود، تا زمانی که لغو کنید.\nهر زمان پیش از {date} می‌توانید از تنظیمات صورتحساب لغو کنید و هیچ مبلغی کسر نخواهد شد.\nلطفاً این ایمیل را برای سوابق خود نگه دارید.",
    ja: "{name}様、Vireek {plan}プランの無料トライアルが始まりました。\n{date}までに解約されない場合、その日に登録済みのお支払い方法へ{amount}が請求されます。その後、プランは同じ料金で解約されるまで1{interval}ごとに自動更新されます。\n{date}より前であれば、請求設定からいつでも解約でき、請求は発生しません。\nこのメールは記録として保管してください。",
  },
  "billing.cancelled.subject": {
    en: "Your Vireek {plan} plan won't renew",
    es: "Su plan {plan} de Vireek no se renovará",
    zh: "您的 Vireek {plan} 套餐将不再续订",
    hi: "आपका Vireek {plan} प्लान रिन्यू नहीं होगा",
    fr: "Votre forfait Vireek {plan} ne sera pas renouvelé",
    de: "Ihr Vireek-Tarif {plan} wird nicht verlängert",
    ar: "لن تتجدد باقة Vireek {plan} الخاصة بك",
    fa: "طرح {plan} Vireek شما تمدید نخواهد شد",
    ja: "Vireek {plan}プランは更新されません",
  },
  "billing.cancelled.body": {
    en: "Hi {name}, we've scheduled the cancellation of your Vireek {plan} plan. It will not renew.\nYou keep full access until {date}.\nChanged your mind? You can undo the cancellation from your billing settings any time before {date}.",
    es: "Hola {name}, hemos programado la cancelación de su plan {plan} de Vireek. No se renovará.\nConserva el acceso completo hasta el {date}.\n¿Ha cambiado de opinión? Puede deshacer la cancelación desde la configuración de facturación en cualquier momento antes del {date}.",
    zh: "{name}，您好，我们已为您的 Vireek {plan} 套餐安排取消，该套餐将不再续订。\n您可继续完整使用服务直至 {date}。\n改变主意了？您可以在 {date} 之前随时在账单设置中撤销取消。",
    hi: "नमस्ते {name}, हमने आपके Vireek {plan} प्लान को रद्द करने की व्यवस्था कर दी है। यह रिन्यू नहीं होगा।\n{date} तक आपको पूरा एक्सेस मिलता रहेगा।\nमन बदल गया? {date} से पहले आप कभी भी बिलिंग सेटिंग से रद्दीकरण वापस ले सकते हैं।",
    fr: "Bonjour {name}, nous avons programmé la résiliation de votre forfait Vireek {plan}. Il ne sera pas renouvelé.\nVous conservez l'accès complet jusqu'au {date}.\nVous avez changé d'avis ? Vous pouvez annuler la résiliation depuis vos paramètres de facturation à tout moment avant le {date}.",
    de: "Hallo {name}, wir haben die Kündigung Ihres Vireek-Tarifs {plan} vorgemerkt. Er wird nicht verlängert.\nSie behalten den vollen Zugang bis zum {date}.\nHaben Sie es sich anders überlegt? Sie können die Kündigung vor dem {date} jederzeit in Ihren Abrechnungseinstellungen zurücknehmen.",
    ar: "مرحباً {name}، تمت جدولة إلغاء باقة Vireek {plan} الخاصة بك. لن تتجدد الباقة.\nتحتفظ بإمكانية الوصول الكاملة حتى {date}.\nهل غيّرت رأيك؟ يمكنك التراجع عن الإلغاء من إعدادات الفوترة في أي وقت قبل {date}.",
    fa: "سلام {name}، لغو طرح {plan} Vireek شما ثبت شد و این طرح تمدید نخواهد شد.\nتا {date} دسترسی کامل شما حفظ می‌شود.\nنظرتان عوض شد؟ تا پیش از {date} هر زمان می‌توانید لغو را از تنظیمات صورتحساب بازگردانید.",
    ja: "{name}様、Vireek {plan}プランの解約を受け付けました。プランは更新されません。\n{date}まではすべての機能をご利用いただけます。\n解約を取り消したい場合は、{date}より前であれば請求設定からいつでも取り消せます。",
  },
  "billing.price_change.subject": {
    en: "Upcoming change to your Vireek {plan} plan on {date}",
    es: "Cambio próximo en su plan {plan} de Vireek el {date}",
    zh: "您的 Vireek {plan} 套餐将于 {date} 发生变更",
    hi: "{date} से आपके Vireek {plan} प्लान में बदलाव",
    fr: "Changement à venir de votre forfait Vireek {plan} le {date}",
    de: "Anstehende Änderung Ihres Vireek-Tarifs {plan} am {date}",
    ar: "تغيير قادم على باقة Vireek {plan} الخاصة بك في {date}",
    fa: "تغییر پیش‌رو در طرح {plan} Vireek شما از {date}",
    ja: "{date}からのVireek {plan}プランの変更のお知らせ",
  },
  "billing.price_change.body": {
    en: "Hi {name}, starting {date}, a change will apply to your Vireek {plan} plan: {summary}\nYou don't need to do anything to continue. If you'd rather change your plan or cancel, you can do that in your billing settings before {date}.",
    es: "Hola {name}, a partir del {date} se aplicará un cambio a su plan {plan} de Vireek: {summary}\nNo necesita hacer nada para continuar. Si prefiere cambiar de plan o cancelar, puede hacerlo en la configuración de facturación antes del {date}.",
    zh: "{name}，您好，自 {date} 起，您的 Vireek {plan} 套餐将发生以下变更：{summary}\n如需继续使用，您无需任何操作。如果您希望更改套餐或取消，可在 {date} 之前在账单设置中操作。",
    hi: "नमस्ते {name}, {date} से आपके Vireek {plan} प्लान में यह बदलाव लागू होगा: {summary}\nजारी रखने के लिए आपको कुछ करने की आवश्यकता नहीं है। यदि आप प्लान बदलना या रद्द करना चाहते हैं, तो {date} से पहले बिलिंग सेटिंग में ऐसा कर सकते हैं।",
    fr: "Bonjour {name}, à partir du {date}, un changement s'appliquera à votre forfait Vireek {plan} : {summary}\nVous n'avez rien à faire pour continuer. Si vous préférez changer de forfait ou résilier, vous pouvez le faire dans vos paramètres de facturation avant le {date}.",
    de: "Hallo {name}, ab dem {date} gilt für Ihren Vireek-Tarif {plan} folgende Änderung: {summary}\nSie müssen nichts tun, um fortzufahren. Wenn Sie lieber den Tarif wechseln oder kündigen möchten, können Sie das vor dem {date} in Ihren Abrechnungseinstellungen tun.",
    ar: "مرحباً {name}، اعتباراً من {date} سيُطبَّق تغيير على باقة Vireek {plan} الخاصة بك: {summary}\nلا تحتاج إلى أي إجراء للاستمرار. وإذا فضّلت تغيير الباقة أو إلغاءها، يمكنك ذلك من إعدادات الفوترة قبل {date}.",
    fa: "سلام {name}، از {date} تغییری در طرح {plan} Vireek شما اعمال می‌شود: {summary}\nبرای ادامه نیازی به هیچ اقدامی نیست. اگر می‌خواهید طرح را تغییر دهید یا لغو کنید، پیش از {date} می‌توانید این کار را در تنظیمات صورتحساب انجام دهید.",
    ja: "{name}様、{date}より、Vireek {plan}プランに次の変更が適用されます：{summary}\nご継続にあたり操作は不要です。プランの変更や解約をご希望の場合は、{date}までに請求設定から行えます。",
  },
  "billing.price_change.summary_price": {
    en: "the price changes from {old_price} to {new_price} per billing period.",
    es: "el precio pasa de {old_price} a {new_price} por período de facturación.",
    zh: "价格由每个计费周期 {old_price} 调整为 {new_price}。",
    hi: "कीमत प्रति बिलिंग अवधि {old_price} से बदलकर {new_price} हो जाएगी।",
    fr: "le prix passe de {old_price} à {new_price} par période de facturation.",
    de: "der Preis ändert sich von {old_price} auf {new_price} pro Abrechnungszeitraum.",
    ar: "يتغير السعر من {old_price} إلى {new_price} لكل فترة فوترة.",
    fa: "قیمت از {old_price} به {new_price} در هر دوره صورتحساب تغییر می‌کند.",
    ja: "料金は請求期間ごとに{old_price}から{new_price}に変更されます。",
  },
  "billing.price_change.summary_limit": {
    en: "the included minutes change from {old_minutes} to {new_minutes} per month.",
    es: "los minutos incluidos pasan de {old_minutes} a {new_minutes} al mes.",
    zh: "每月包含的分钟数由 {old_minutes} 调整为 {new_minutes}。",
    hi: "शामिल मिनट प्रति माह {old_minutes} से घटकर {new_minutes} हो जाएँगे।",
    fr: "les minutes incluses passent de {old_minutes} à {new_minutes} par mois.",
    de: "die enthaltenen Minuten ändern sich von {old_minutes} auf {new_minutes} pro Monat.",
    ar: "تتغير الدقائق المشمولة من {old_minutes} إلى {new_minutes} شهرياً.",
    fa: "دقیقه‌های شامل‌شده از {old_minutes} به {new_minutes} در ماه تغییر می‌کند.",
    ja: "含まれる通話時間は月あたり{old_minutes}分から{new_minutes}分に変更されます。",
  },
  "billing.suspended.payment.subject": {
    en: "Your Vireek service is paused: payment needed",
    es: "Su servicio de Vireek está en pausa: se requiere un pago",
    zh: "您的 Vireek 服务已暂停：需要付款",
    hi: "आपकी Vireek सेवा रुकी हुई है: भुगतान आवश्यक है",
    fr: "Votre service Vireek est suspendu : paiement requis",
    de: "Ihr Vireek-Dienst ist pausiert: Zahlung erforderlich",
    ar: "تم إيقاف خدمة Vireek مؤقتاً: الدفع مطلوب",
    fa: "سرویس Vireek شما متوقف شده است: پرداخت لازم است",
    ja: "Vireekのサービスが一時停止中です：お支払いが必要です",
  },
  "billing.suspended.payment.body": {
    en: "Hi {name}, we couldn't collect payment for your Vireek subscription and the grace period has ended, so your account is now paused. Your AI receptionist is not answering calls right now.\nTo restore service: 1) open your billing settings and update your payment method; 2) pay any outstanding invoice. Service resumes automatically once the payment succeeds.\nNeed help? Contact us at {support_email}.",
    es: "Hola {name}, no pudimos cobrar su suscripción de Vireek y el período de gracia terminó, por lo que su cuenta está en pausa. Su recepcionista con IA no está atendiendo llamadas por ahora.\nPara restablecer el servicio: 1) abra la configuración de facturación y actualice su método de pago; 2) pague cualquier factura pendiente. El servicio se reanuda automáticamente cuando el pago se procese.\n¿Necesita ayuda? Escríbanos a {support_email}.",
    zh: "{name}，您好，我们未能收取您的 Vireek 订阅费用，宽限期已结束，您的账户现已暂停，AI 前台目前不会接听来电。\n恢复服务：1）打开账单设置并更新付款方式；2）支付所有未付账单。付款成功后服务将自动恢复。\n需要帮助？请联系 {support_email}。",
    hi: "नमस्ते {name}, हम आपकी Vireek सदस्यता का भुगतान नहीं ले सके और ग्रेस अवधि समाप्त हो गई है, इसलिए आपका खाता रोक दिया गया है। आपकी AI रिसेप्शनिस्ट अभी कॉल का उत्तर नहीं दे रही है।\nसेवा बहाल करने के लिए: 1) बिलिंग सेटिंग खोलकर अपनी भुगतान विधि अपडेट करें; 2) बकाया इनवॉइस का भुगतान करें। भुगतान सफल होते ही सेवा अपने-आप फिर शुरू हो जाएगी।\nमदद चाहिए? {support_email} पर संपर्क करें।",
    fr: "Bonjour {name}, nous n'avons pas pu prélever le paiement de votre abonnement Vireek et le délai de grâce est terminé : votre compte est donc suspendu. Votre réceptionniste IA ne répond plus aux appels pour le moment.\nPour rétablir le service : 1) ouvrez vos paramètres de facturation et mettez à jour votre moyen de paiement ; 2) réglez toute facture en attente. Le service reprend automatiquement dès que le paiement aboutit.\nBesoin d'aide ? Écrivez-nous à {support_email}.",
    de: "Hallo {name}, wir konnten die Zahlung für Ihr Vireek-Abonnement nicht einziehen und die Nachfrist ist abgelaufen, daher ist Ihr Konto jetzt pausiert. Ihre KI-Rezeptionistin nimmt derzeit keine Anrufe entgegen.\nSo stellen Sie den Dienst wieder her: 1) Öffnen Sie Ihre Abrechnungseinstellungen und aktualisieren Sie Ihre Zahlungsmethode; 2) begleichen Sie offene Rechnungen. Der Dienst läuft automatisch weiter, sobald die Zahlung erfolgreich ist.\nBrauchen Sie Hilfe? Schreiben Sie uns an {support_email}.",
    ar: "مرحباً {name}، لم نتمكن من تحصيل دفعة اشتراكك في Vireek وقد انتهت فترة السماح، لذا تم إيقاف حسابك مؤقتاً. موظفة الاستقبال بالذكاء الاصطناعي لا ترد على المكالمات حالياً.\nلاستعادة الخدمة: 1) افتح إعدادات الفوترة وحدّث وسيلة الدفع؛ 2) سدّد أي فاتورة مستحقة. تُستأنف الخدمة تلقائياً بمجرد نجاح الدفع.\nتحتاج مساعدة؟ راسلنا على {support_email}.",
    fa: "سلام {name}، نتوانستیم مبلغ اشتراک Vireek شما را دریافت کنیم و مهلت تمام شده است؛ بنابراین حساب شما اکنون متوقف شده و منشی هوش مصنوعی شما فعلاً به تماس‌ها پاسخ نمی‌دهد.\nبرای بازگرداندن سرویس: ۱) تنظیمات صورتحساب را باز کنید و روش پرداخت را به‌روزرسانی کنید؛ ۲) فاکتورهای پرداخت‌نشده را بپردازید. پس از موفقیت پرداخت، سرویس خودکار از سر گرفته می‌شود.\nکمک لازم دارید؟ با {support_email} تماس بگیرید.",
    ja: "{name}様、Vireekのサブスクリプション料金を回収できず、猶予期間も終了したため、アカウントを一時停止しました。現在、AI受付はお電話に応答していません。\nサービスを再開するには：1）請求設定を開き、お支払い方法を更新する　2）未払いの請求書をお支払いする。お支払いが完了すると、サービスは自動的に再開されます。\nご不明な点は {support_email} までご連絡ください。",
  },
  "billing.suspended.payment.sms": {
    en: "Vireek: your service is paused because a payment failed. Update your payment method to restore it: {url}",
    es: "Vireek: su servicio está en pausa porque falló un pago. Actualice su método de pago para restablecerlo: {url}",
    zh: "Vireek：因付款失败，您的服务已暂停。请更新付款方式以恢复：{url}",
    hi: "Vireek: भुगतान विफल होने के कारण आपकी सेवा रुकी हुई है। बहाल करने के लिए भुगतान विधि अपडेट करें: {url}",
    fr: "Vireek : votre service est suspendu suite à un paiement échoué. Mettez à jour votre moyen de paiement pour le rétablir : {url}",
    de: "Vireek: Ihr Dienst ist pausiert, weil eine Zahlung fehlgeschlagen ist. Zahlungsmethode aktualisieren: {url}",
    ar: "Vireek: خدمتك متوقفة بسبب فشل عملية دفع. حدّث وسيلة الدفع لاستعادتها: {url}",
    fa: "Vireek: به‌دلیل ناموفق بودن یک پرداخت، سرویس شما متوقف شده است. برای بازگرداندن آن روش پرداخت را به‌روزرسانی کنید: {url}",
    ja: "Vireek：お支払いに失敗したためサービスを一時停止中です。お支払い方法を更新して再開してください：{url}",
  },
  "billing.suspended.fraud.subject_suspended": {
    en: "Outbound calling and texting is paused on your Vireek account",
    es: "Las llamadas y mensajes salientes están en pausa en su cuenta de Vireek",
    zh: "您的 Vireek 账户已暂停外呼和短信",
    hi: "आपके Vireek खाते पर आउटबाउंड कॉल और टेक्स्ट रोक दिए गए हैं",
    fr: "Les appels et SMS sortants sont suspendus sur votre compte Vireek",
    de: "Ausgehende Anrufe und SMS sind in Ihrem Vireek-Konto pausiert",
    ar: "تم إيقاف المكالمات والرسائل الصادرة على حسابك في Vireek",
    fa: "تماس و پیامک خروجی در حساب Vireek شما متوقف شده است",
    ja: "Vireekアカウントで発信通話とSMSが一時停止されました",
  },
  "billing.suspended.fraud.subject_throttled": {
    en: "Outbound calling and texting is temporarily limited on your Vireek account",
    es: "Las llamadas y mensajes salientes están limitados temporalmente en su cuenta de Vireek",
    zh: "您的 Vireek 账户外呼和短信已被暂时限制",
    hi: "आपके Vireek खाते पर आउटबाउंड कॉल और टेक्स्ट अस्थायी रूप से सीमित हैं",
    fr: "Les appels et SMS sortants sont temporairement limités sur votre compte Vireek",
    de: "Ausgehende Anrufe und SMS sind in Ihrem Vireek-Konto vorübergehend eingeschränkt",
    ar: "تم تقييد المكالمات والرسائل الصادرة على حسابك في Vireek مؤقتاً",
    fa: "تماس و پیامک خروجی در حساب Vireek شما موقتاً محدود شده است",
    ja: "Vireekアカウントで発信通話とSMSが一時的に制限されています",
  },
  "billing.suspended.fraud.body": {
    en: "Hi {name}, to protect your account we have restricted outbound calling and texting. Incoming calls and your AI receptionist keep working, and emergency transfers are not affected.\nIf you think this is a mistake, contact us at {support_email} or appeal in Settings > Security ({url}). A person will review it.",
    es: "Hola {name}, para proteger su cuenta hemos restringido las llamadas y mensajes salientes. Las llamadas entrantes y su recepcionista con IA siguen funcionando, y las transferencias de emergencia no se ven afectadas.\nSi cree que es un error, escríbanos a {support_email} o apele en Configuración > Seguridad ({url}). Una persona lo revisará.",
    zh: "{name}，您好，为保护您的账户，我们已限制外呼和短信功能。来电和 AI 前台仍可正常使用，紧急转接不受影响。\n如果您认为这是误判，请联系 {support_email}，或在“设置 > 安全”中申诉（{url}）。我们会安排专人审核。",
    hi: "नमस्ते {name}, आपके खाते की सुरक्षा के लिए हमने आउटबाउंड कॉल और टेक्स्ट सीमित कर दिए हैं। इनकमिंग कॉल और आपकी AI रिसेप्शनिस्ट सामान्य रूप से काम करती रहेंगी, और आपातकालीन ट्रांसफ़र प्रभावित नहीं होंगे।\nयदि आपको लगता है कि यह गलती है, तो {support_email} पर संपर्क करें या सेटिंग > सुरक्षा ({url}) में अपील करें। कोई व्यक्ति इसकी समीक्षा करेगा।",
    fr: "Bonjour {name}, pour protéger votre compte, nous avons restreint les appels et SMS sortants. Les appels entrants et votre réceptionniste IA continuent de fonctionner, et les transferts d'urgence ne sont pas affectés.\nSi vous pensez qu'il s'agit d'une erreur, écrivez-nous à {support_email} ou faites appel dans Paramètres > Sécurité ({url}). Une personne examinera votre demande.",
    de: "Hallo {name}, zum Schutz Ihres Kontos haben wir ausgehende Anrufe und SMS eingeschränkt. Eingehende Anrufe und Ihre KI-Rezeptionistin funktionieren weiterhin, Notfall-Weiterleitungen sind nicht betroffen.\nWenn Sie glauben, dass es sich um einen Irrtum handelt, schreiben Sie uns an {support_email} oder legen Sie unter Einstellungen > Sicherheit Einspruch ein ({url}). Eine Person prüft Ihren Fall.",
    ar: "مرحباً {name}، لحماية حسابك قمنا بتقييد المكالمات والرسائل الصادرة. تستمر المكالمات الواردة وموظفة الاستقبال بالذكاء الاصطناعي في العمل، ولا تتأثر تحويلات الطوارئ.\nإذا كنت تعتقد أن هذا خطأ، راسلنا على {support_email} أو قدّم اعتراضاً من الإعدادات > الأمان ({url}). سيراجع الطلب شخص مختص.",
    fa: "سلام {name}، برای محافظت از حساب شما، تماس و پیامک خروجی را محدود کرده‌ایم. تماس‌های ورودی و منشی هوش مصنوعی شما همچنان کار می‌کنند و انتقال‌های اضطراری تحت تأثیر نیستند.\nاگر فکر می‌کنید اشتباهی رخ داده، با {support_email} تماس بگیرید یا از «تنظیمات > امنیت» ({url}) درخواست بازبینی ثبت کنید. یک نفر آن را بررسی خواهد کرد.",
    ja: "{name}様、アカウント保護のため、発信通話とSMSを制限しました。着信とAI受付は引き続きご利用いただけ、緊急転送への影響はありません。\n誤りだと思われる場合は {support_email} までご連絡いただくか、設定 > セキュリティ（{url}）から異議申し立てを行ってください。担当者が確認します。",
  },
  "billing.notice.cta_billing": {
    en: "Open billing settings",
    es: "Abrir configuración de facturación",
    zh: "打开账单设置",
    hi: "बिलिंग सेटिंग खोलें",
    fr: "Ouvrir les paramètres de facturation",
    de: "Abrechnungseinstellungen öffnen",
    ar: "افتح إعدادات الفوترة",
    fa: "باز کردن تنظیمات صورتحساب",
    ja: "請求設定を開く",
  },
  "billing.notice.cta_update_payment": {
    en: "Update payment method",
    es: "Actualizar método de pago",
    zh: "更新付款方式",
    hi: "भुगतान विधि अपडेट करें",
    fr: "Mettre à jour le moyen de paiement",
    de: "Zahlungsmethode aktualisieren",
    ar: "تحديث وسيلة الدفع",
    fa: "به‌روزرسانی روش پرداخت",
    ja: "お支払い方法を更新",
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
