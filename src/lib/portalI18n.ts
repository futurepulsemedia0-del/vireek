import { useEffect } from 'react';
import { createInstance } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useAccessibility } from '@/contexts/AccessibilityContext';
import { resolveInitialLanguage, readUrlLanguage } from '@/lib/languageSync';
import {
  fetchInvoiceLanguage,
  fetchPortalLanguage,
  savePortalLanguage,
  type LanguageCode,
} from '@/lib/customerLanguage';

/* ------------------------------------------------------------------ */
/*  Customer-facing pages (portal, public invoice): the key IS the      */
/*  English source text, so a missing translation silently falls back   */
/*  to the English string already in the JSX.                           */
/* ------------------------------------------------------------------ */

type Target = Exclude<LanguageCode, 'en'>;
const ORDER: Target[] = ['es', 'zh', 'hi', 'fr', 'de', 'ar', 'fa', 'ja'];

// [english, es, zh, hi, fr, de, ar, fa, ja]
const ROWS: string[][] = [
  [
    'My Appointments',
    'Mis citas',
    '我的预约',
    'मेरी अपॉइंटमेंट',
    'Mes rendez-vous',
    'Meine Termine',
    'مواعيدي',
    'قرارهای ملاقات من',
    'ご予約',
  ],
  [
    'Quotes',
    'Presupuestos',
    '报价',
    'कोटेशन',
    'Devis',
    'Angebote',
    'عروض الأسعار',
    'پیش‌فاکتورها',
    '見積もり',
  ],
  ['Equipment', 'Equipos', '设备', 'उपकरण', 'Équipements', 'Geräte', 'المعدات', 'تجهیزات', '設備'],
  [
    'Refer & Earn',
    'Recomienda y gana',
    '推荐有礼',
    'रेफ़र करें और कमाएँ',
    'Parrainez et gagnez',
    'Empfehlen & verdienen',
    'أحِل واربح',
    'معرفی و دریافت پاداش',
    '紹介特典',
  ],
  [
    'Request Service',
    'Solicitar servicio',
    '申请服务',
    'सेवा का अनुरोध करें',
    'Demander un service',
    'Service anfragen',
    'طلب خدمة',
    'درخواست خدمات',
    'サービスを依頼',
  ],
  [
    'My Info',
    'Mis datos',
    '我的信息',
    'मेरी जानकारी',
    'Mes informations',
    'Meine Daten',
    'معلوماتي',
    'اطلاعات من',
    'お客様情報',
  ],
  [
    'Loading your account…',
    'Cargando su cuenta…',
    '正在加载您的账户…',
    'आपका खाता लोड हो रहा है…',
    'Chargement de votre compte…',
    'Ihr Konto wird geladen…',
    'جارٍ تحميل حسابك…',
    'در حال بارگذاری حساب شما…',
    'アカウントを読み込んでいます…',
  ],
  [
    'Portal not available',
    'Portal no disponible',
    '门户不可用',
    'पोर्टल उपलब्ध नहीं है',
    'Portail indisponible',
    'Portal nicht verfügbar',
    'البوابة غير متاحة',
    'پورتال در دسترس نیست',
    'ポータルをご利用いただけません',
  ],
  [
    'Upcoming',
    'Próximas',
    '即将到来',
    'आगामी',
    'À venir',
    'Anstehend',
    'القادمة',
    'پیش‌رو',
    '今後の予定',
  ],
  [
    'Past Service',
    'Servicios anteriores',
    '过往服务',
    'पिछली सेवाएँ',
    'Services passés',
    'Frühere Services',
    'الخدمات السابقة',
    'خدمات گذشته',
    '過去のサービス',
  ],
  [
    'No upcoming appointments.',
    'No hay citas próximas.',
    '暂无即将到来的预约。',
    'कोई आगामी अपॉइंटमेंट नहीं है।',
    'Aucun rendez-vous à venir.',
    'Keine anstehenden Termine.',
    'لا توجد مواعيد قادمة.',
    'قرار ملاقاتی در پیش نیست.',
    '今後のご予約はありません。',
  ],
  [
    'No past service on file yet.',
    'Aún no hay servicios anteriores registrados.',
    '暂无过往服务记录。',
    'अभी तक कोई पिछली सेवा दर्ज नहीं है।',
    'Aucun service passé enregistré.',
    'Noch keine früheren Services hinterlegt.',
    'لا توجد خدمات سابقة مسجلة بعد.',
    'هنوز سرویس گذشته‌ای ثبت نشده است.',
    '過去のサービス履歴はまだありません。',
  ],
  [
    'Book new service',
    'Reservar un nuevo servicio',
    '预约新服务',
    'नई सेवा बुक करें',
    'Réserver un nouveau service',
    'Neuen Service buchen',
    'احجز خدمة جديدة',
    'رزرو سرویس جدید',
    '新しいサービスを予約',
  ],
  [
    'Reschedule',
    'Reprogramar',
    '改期',
    'समय बदलें',
    'Reporter',
    'Verschieben',
    'إعادة الجدولة',
    'تغییر زمان',
    '日時を変更',
  ],
  [
    'Pay now',
    'Pagar ahora',
    '立即付款',
    'अभी भुगतान करें',
    'Payer maintenant',
    'Jetzt bezahlen',
    'ادفع الآن',
    'پرداخت',
    '今すぐ支払う',
  ],
  [
    'Send request',
    'Enviar solicitud',
    '发送请求',
    'अनुरोध भेजें',
    'Envoyer la demande',
    'Anfrage senden',
    'إرسال الطلب',
    'ارسال درخواست',
    'リクエストを送信',
  ],
  [
    'Save changes',
    'Guardar cambios',
    '保存更改',
    'बदलाव सहेजें',
    'Enregistrer',
    'Änderungen speichern',
    'حفظ التغييرات',
    'ذخیره تغییرات',
    '変更を保存',
  ],
  [
    'Saved.',
    'Guardado.',
    '已保存。',
    'सहेजा गया।',
    'Enregistré.',
    'Gespeichert.',
    'تم الحفظ.',
    'ذخیره شد.',
    '保存しました。',
  ],
  ['Language', 'Idioma', '语言', 'भाषा', 'Langue', 'Sprache', 'اللغة', 'زبان', '言語'],
  [
    'Language saved.',
    'Idioma guardado.',
    '语言已保存。',
    'भाषा सहेजी गई।',
    'Langue enregistrée.',
    'Sprache gespeichert.',
    'تم حفظ اللغة.',
    'زبان ذخیره شد.',
    '言語を保存しました。',
  ],
  [
    'Choose the language we use to contact you.',
    'Elija el idioma en el que nos comunicamos con usted.',
    '选择我们与您联系时使用的语言。',
    'चुनें कि हम आपसे किस भाषा में संपर्क करें।',
    'Choisissez la langue dans laquelle nous vous contactons.',
    'Wählen Sie die Sprache, in der wir Sie kontaktieren.',
    'اختر اللغة التي نتواصل بها معك.',
    'زبانی را که با شما در آن ارتباط می‌گیریم انتخاب کنید.',
    'ご連絡に使用する言語をお選びください。',
  ],
  ['Phone', 'Teléfono', '电话', 'फ़ोन', 'Téléphone', 'Telefon', 'الهاتف', 'تلفن', '電話番号'],
  [
    'Email',
    'Correo electrónico',
    '电子邮件',
    'ईमेल',
    'E-mail',
    'E-Mail',
    'البريد الإلكتروني',
    'ایمیل',
    'メールアドレス',
  ],
  [
    'Hi {{name}},',
    'Hola {{name}},',
    '{{name}}，您好：',
    'नमस्ते {{name}},',
    'Bonjour {{name}},',
    'Hallo {{name}},',
    'مرحباً {{name}}،',
    'سلام {{name}}،',
    '{{name}}様',
  ],
  [
    'Your account with {{business}}',
    'Su cuenta con {{business}}',
    '您在 {{business}} 的账户',
    '{{business}} के साथ आपका खाता',
    'Votre compte chez {{business}}',
    'Ihr Konto bei {{business}}',
    'حسابك لدى {{business}}',
    'حساب شما نزد {{business}}',
    '{{business}}のお客様アカウント',
  ],
  [
    'Something is wrong?',
    '¿Hay algún problema?',
    '出问题了？',
    'कोई समस्या है?',
    'Un problème ?',
    'Gibt es ein Problem?',
    'هل هناك مشكلة؟',
    'مشکلی پیش آمده؟',
    'トラブルですか？',
  ],
  [
    'Start now',
    'Comenzar ahora',
    '立即开始',
    'अभी शुरू करें',
    'Commencer',
    'Jetzt starten',
    'ابدأ الآن',
    'شروع کنید',
    '今すぐ開始',
  ],
  [
    'Full service history',
    'Historial completo de servicios',
    '完整服务记录',
    'पूरा सेवा इतिहास',
    'Historique complet des services',
    'Vollständiger Serviceverlauf',
    'سجل الخدمة الكامل',
    'تاریخچه کامل خدمات',
    'サービス履歴をすべて見る',
  ],
  [
    'Scheduled',
    'Programada',
    '已预约',
    'निर्धारित',
    'Planifié',
    'Geplant',
    'مجدولة',
    'برنامه‌ریزی‌شده',
    '予約済み',
  ],
  [
    'Technician en route',
    'Técnico en camino',
    '技师正在途中',
    'तकनीशियन रास्ते में है',
    'Technicien en route',
    'Techniker ist unterwegs',
    'الفني في الطريق',
    'تکنسین در راه است',
    '技術者が移動中',
  ],
  [
    'In progress',
    'En curso',
    '进行中',
    'प्रगति पर',
    'En cours',
    'In Bearbeitung',
    'قيد التنفيذ',
    'در حال انجام',
    '作業中',
  ],
  [
    'Completed',
    'Completada',
    '已完成',
    'पूर्ण',
    'Terminé',
    'Abgeschlossen',
    'مكتملة',
    'انجام‌شده',
    '完了',
  ],
  [
    'No-show',
    'No se presentó',
    '未到场',
    'उपस्थित नहीं हुए',
    'Absence',
    'Nicht erschienen',
    'لم يحضر',
    'عدم حضور',
    '不在',
  ],
  [
    'Cancelled',
    'Cancelada',
    '已取消',
    'रद्द',
    'Annulé',
    'Storniert',
    'ملغاة',
    'لغوشده',
    'キャンセル',
  ],
  [
    'Not yet invoiced',
    'Aún sin facturar',
    '尚未开具账单',
    'अभी तक इनवॉइस नहीं बना',
    'Pas encore facturé',
    'Noch nicht berechnet',
    'لم تُصدر فاتورة بعد',
    'هنوز فاکتور نشده',
    '未請求',
  ],
  [
    'Invoice sent — payment due',
    'Factura enviada — pago pendiente',
    '账单已发送 — 待付款',
    'इनवॉइस भेजा गया — भुगतान देय',
    'Facture envoyée — paiement dû',
    'Rechnung gesendet — Zahlung fällig',
    'تم إرسال الفاتورة — الدفع مستحق',
    'فاکتور ارسال شد — در انتظار پرداخت',
    '請求書送付済み — お支払い待ち',
  ],
  [
    'Paid',
    'Pagada',
    '已付款',
    'भुगतान हो चुका',
    'Payé',
    'Bezahlt',
    'مدفوعة',
    'پرداخت‌شده',
    'お支払い済み',
  ],
  [
    'Not yet scheduled',
    'Aún sin programar',
    '尚未安排',
    'अभी तक निर्धारित नहीं',
    'Pas encore planifié',
    'Noch nicht geplant',
    'لم تُجدول بعد',
    'هنوز زمان‌بندی نشده',
    '日程未定',
  ],
  [
    'No warranty on file',
    'Sin garantía registrada',
    '暂无保修记录',
    'कोई वारंटी दर्ज नहीं',
    'Aucune garantie enregistrée',
    'Keine Garantie hinterlegt',
    'لا توجد ضمانة مسجلة',
    'گارانتی ثبت نشده است',
    '保証情報なし',
  ],
  [
    'Expired {{date}}',
    'Venció el {{date}}',
    '已于 {{date}} 过期',
    '{{date}} को समाप्त',
    'Expirée le {{date}}',
    'Abgelaufen am {{date}}',
    'انتهت في {{date}}',
    'منقضی شده در {{date}}',
    '{{date}}に期限切れ',
  ],
  [
    'Expires {{date}}',
    'Vence el {{date}}',
    '将于 {{date}} 到期',
    '{{date}} को समाप्त होगी',
    'Expire le {{date}}',
    'Läuft ab am {{date}}',
    'تنتهي في {{date}}',
    'انقضا در {{date}}',
    '{{date}}に期限切れ予定',
  ],
  [
    'Covered until {{date}}',
    'Cubierto hasta el {{date}}',
    '保修至 {{date}}',
    '{{date}} तक कवर',
    'Couvert jusqu’au {{date}}',
    'Abgedeckt bis {{date}}',
    'مشمولة حتى {{date}}',
    'تحت پوشش تا {{date}}',
    '{{date}}まで保証',
  ],
  ['Draft', 'Borrador', '草稿', 'ड्राफ़्ट', 'Brouillon', 'Entwurf', 'مسودة', 'پیش‌نویس', '下書き'],
  [
    'Awaiting your response',
    'Esperando su respuesta',
    '等待您的回复',
    'आपके उत्तर की प्रतीक्षा है',
    'En attente de votre réponse',
    'Wartet auf Ihre Antwort',
    'بانتظار ردك',
    'در انتظار پاسخ شما',
    'ご返答をお待ちしています',
  ],
  [
    'Accepted',
    'Aceptado',
    '已接受',
    'स्वीकृत',
    'Accepté',
    'Angenommen',
    'مقبول',
    'پذیرفته‌شده',
    '承諾済み',
  ],
  [
    'Declined',
    'Rechazado',
    '已拒绝',
    'अस्वीकृत',
    'Refusé',
    'Abgelehnt',
    'مرفوض',
    'ردشده',
    '辞退済み',
  ],
  [
    'Expired',
    'Vencido',
    '已过期',
    'समाप्त',
    'Expiré',
    'Abgelaufen',
    'منتهٍ',
    'منقضی‌شده',
    '期限切れ',
  ],
];

// Common words used on a public invoice page (applied via pt() where the page uses the same English text).
const INVOICE_ROWS: string[][] = [
  ['Invoice', 'Factura', '账单', 'इनवॉइस', 'Facture', 'Rechnung', 'الفاتورة', 'فاکتور', '請求書'],
  [
    'Subtotal',
    'Subtotal',
    '小计',
    'उप-योग',
    'Sous-total',
    'Zwischensumme',
    'المجموع الفرعي',
    'جمع جزء',
    '小計',
  ],
  ['Tax', 'Impuesto', '税费', 'कर', 'Taxe', 'Steuer', 'الضريبة', 'مالیات', '税'],
  ['Total', 'Total', '合计', 'कुल', 'Total', 'Gesamt', 'الإجمالي', 'مجموع', '合計'],
  [
    'Balance due',
    'Saldo pendiente',
    '应付余额',
    'देय शेष राशि',
    'Solde à payer',
    'Offener Betrag',
    'الرصيد المستحق',
    'مانده قابل پرداخت',
    'お支払い残高',
  ],
  [
    'Due date',
    'Fecha de vencimiento',
    '到期日',
    'देय तिथि',
    'Date d’échéance',
    'Fälligkeitsdatum',
    'تاريخ الاستحقاق',
    'سررسید',
    'お支払い期限',
  ],
  [
    'Description',
    'Descripción',
    '说明',
    'विवरण',
    'Description',
    'Beschreibung',
    'الوصف',
    'شرح',
    '内容',
  ],
  ['Qty', 'Cant.', '数量', 'मात्रा', 'Qté', 'Menge', 'الكمية', 'تعداد', '数量'],
  [
    'Notes',
    'Notas',
    '备注',
    'टिप्पणियाँ',
    'Remarques',
    'Hinweise',
    'ملاحظات',
    'یادداشت‌ها',
    '備考',
  ],
  [
    'Billed to',
    'Facturado a',
    '开票对象',
    'बिल प्राप्तकर्ता',
    'Facturé à',
    'Rechnung an',
    'الفاتورة إلى',
    'صورتحساب برای',
    '請求先',
  ],
  ['Void', 'Anulada', '已作废', 'रद्द', 'Annulée', 'Storniert', 'ملغاة', 'باطل‌شده', '無効'],
];

export const PORTAL_ROWS: readonly string[][] = [...ROWS, ...INVOICE_ROWS];
export const PORTAL_TARGETS: readonly Target[] = ORDER;

function buildResources() {
  const res: Record<string, { portal: Record<string, string> }> = {};
  ORDER.forEach((lng, i) => {
    res[lng] = { portal: Object.fromEntries(PORTAL_ROWS.map((r) => [r[0], r[i + 1]])) };
  });
  res.en = { portal: {} }; // key = English source text; missing => key returned
  return res;
}

export const portalI18n = createInstance();
void portalI18n.init({
  resources: buildResources(),
  lng: resolveInitialLanguage(),
  fallbackLng: 'en',
  ns: ['portal'],
  defaultNS: 'portal',
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false, prefix: '{{', suffix: '}}' },
  returnEmptyString: false,
});

/** Non-hook translate (usable in helpers and child components; the page hook triggers re-renders). */
export function pt(text: string, vars?: Record<string, string | number>): string {
  return portalI18n.t(text, vars) as string;
}

/** Intl locale tag for the portal's current language (Gregorian + Latin digits). */
export function portalLocale(): string {
  const base = (portalI18n.language || 'en').slice(0, 2);
  const map: Record<string, string> = {
    en: 'en-US',
    es: 'es-US',
    zh: 'zh-CN',
    hi: 'hi-IN',
    fr: 'fr-FR',
    de: 'de-DE',
    ar: 'ar',
    fa: 'fa-IR',
    ja: 'ja-JP',
  };
  return `${map[base] ?? 'en-US'}-u-ca-gregory-nu-latn`;
}

type Kind = 'portal' | 'invoice';

function useCustomerDocumentLanguage(kind: Kind, token: string | undefined) {
  const { language, setLanguage } = useAccessibility();
  useTranslation('portal', { i18n: portalI18n }); // subscribe -> re-render on language change

  // Keep the portal catalog on the same language as the page chrome.
  useEffect(() => {
    if (portalI18n.language !== language) void portalI18n.changeLanguage(language);
  }, [language]);

  // The customer's stored preference wins over browser/localStorage, unless the link carried an explicit ?lang=.
  useEffect(() => {
    if (!token || readUrlLanguage()) return;
    let cancelled = false;
    void (async () => {
      const stored =
        kind === 'portal' ? await fetchPortalLanguage(token) : await fetchInvoiceLanguage(token);
      if (!cancelled && stored) setLanguage(stored);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, kind]);

  return { language, setLanguage };
}

/** Customer portal: loads the stored language, and lets the customer change (and persist) it. */
export function usePortalLanguage(token: string | undefined) {
  const { language, setLanguage } = useCustomerDocumentLanguage('portal', token);
  const changeLanguage = async (code: LanguageCode): Promise<boolean> => {
    setLanguage(code);
    return token ? savePortalLanguage(token, code) : false;
  };
  return { language, changeLanguage };
}

/** Public invoice page: applies the invoiced customer's language. Call once at the top of the page component. */
export function usePublicInvoiceLanguage(token: string | undefined) {
  return useCustomerDocumentLanguage('invoice', token);
}
