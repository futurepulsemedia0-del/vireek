#!/usr/bin/env node
// One-off, idempotent: updates src/locales/consent/*.json for the redesigned cookie banner.
// Run once from the repo root:  node scripts/consent/apply-banner-copy.mjs   (then delete this file)
// Only the keys listed below are touched; every other key and its order is preserved.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'src', 'locales', 'consent');

const COPY = {
  en: { title: 'Your privacy, your choice', body: 'We use essential cookies to run Vireek. With your permission, we also use analytics (Google Analytics) and campaign measurement to improve the product. Nothing optional loads until you choose.', accept: 'Accept all', reject: 'Reject all', customize: 'Customize', region: 'Cookie choices', close: 'Close and decide later', provider: 'Set by' },
  fa: { title: 'حریم خصوصی شما، انتخاب شما', body: 'برای اجرای Vireek از کوکی‌های ضروری استفاده می‌کنیم. با اجازه‌ی شما، برای بهبود محصول از تحلیل (Google Analytics) و سنجش کمپین هم استفاده می‌کنیم. تا زمانی که انتخاب نکنید، هیچ مورد اختیاری بارگذاری نمی‌شود.', accept: 'پذیرش همه', reject: 'رد همه', customize: 'سفارشی‌سازی', region: 'انتخاب‌های کوکی', close: 'بستن و تصمیم‌گیری بعداً', provider: 'تنظیم‌شده توسط' },
  ar: { title: 'خصوصيتك، قرارك', body: 'نستخدم ملفات تعريف ارتباط أساسية لتشغيل Vireek. وبموافقتك نستخدم أيضًا التحليلات (Google Analytics) وقياس الحملات لتحسين المنتج. لا يُحمَّل أي عنصر اختياري قبل أن تختار.', accept: 'قبول الكل', reject: 'رفض الكل', customize: 'تخصيص', region: 'خيارات ملفات تعريف الارتباط', close: 'إغلاق والقرار لاحقًا', provider: 'يُعيَّن بواسطة' },
  de: { title: 'Ihre Privatsphäre, Ihre Wahl', body: 'Wir verwenden notwendige Cookies, damit Vireek funktioniert. Mit Ihrer Einwilligung nutzen wir außerdem Analyse (Google Analytics) und Kampagnenmessung, um das Produkt zu verbessern. Nichts Optionales wird geladen, bevor Sie entscheiden.', accept: 'Alle akzeptieren', reject: 'Alle ablehnen', customize: 'Anpassen', region: 'Cookie-Auswahl', close: 'Schließen und später entscheiden', provider: 'Gesetzt von' },
  es: { title: 'Tu privacidad, tu decisión', body: 'Usamos cookies esenciales para que Vireek funcione. Con tu permiso también usamos analítica (Google Analytics) y medición de campañas para mejorar el producto. Nada opcional se carga hasta que elijas.', accept: 'Aceptar todo', reject: 'Rechazar todo', customize: 'Personalizar', region: 'Opciones de cookies', close: 'Cerrar y decidir más tarde', provider: 'Establecido por' },
  fr: { title: 'Votre vie privée, votre choix', body: 'Nous utilisons des cookies essentiels pour faire fonctionner Vireek. Avec votre accord, nous utilisons aussi l’analyse d’audience (Google Analytics) et la mesure de campagnes pour améliorer le produit. Rien d’optionnel ne se charge avant votre choix.', accept: 'Tout accepter', reject: 'Tout refuser', customize: 'Personnaliser', region: 'Choix de cookies', close: 'Fermer et décider plus tard', provider: 'Déposé par' },
  hi: { title: 'आपकी निजता, आपका चुनाव', body: 'Vireek चलाने के लिए हम ज़रूरी कुकी का उपयोग करते हैं। आपकी अनुमति से हम उत्पाद को बेहतर बनाने के लिए एनालिटिक्स (Google Analytics) और कैंपेन मापन भी उपयोग करते हैं। आपके चुनने तक कोई वैकल्पिक चीज़ लोड नहीं होती।', accept: 'सभी स्वीकार करें', reject: 'सभी अस्वीकार करें', customize: 'अनुकूलित करें', region: 'कुकी विकल्प', close: 'बंद करें और बाद में चुनें', provider: 'किसके द्वारा सेट' },
  ja: { title: 'プライバシーはあなたが選べます', body: 'Vireek の動作に必要な Cookie を使用します。ご同意いただいた場合のみ、製品改善のために分析（Google Analytics）とキャンペーン計測も使用します。選択するまで、任意のものは読み込まれません。', accept: 'すべて許可', reject: 'すべて拒否', customize: 'カスタマイズ', region: 'Cookie の選択', close: '閉じて後で決める', provider: '設定元' },
  zh: { title: '您的隐私，由您选择', body: '我们使用必要 Cookie 来运行 Vireek。经您同意，我们还会使用分析（Google Analytics）和营销活动测量来改进产品。在您做出选择之前，不会加载任何可选项。', accept: '全部接受', reject: '全部拒绝', customize: '自定义', region: 'Cookie 选择', close: '关闭，稍后决定', provider: '设置方' },
};

const DISMISS_KEY = 'vireek-consent-dismissed-at';

for (const [lang, c] of Object.entries(COPY)) {
  const file = join(DIR, `${lang}.json`);
  const json = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(json.banner, {
    title: c.title,
    body: c.body,
    accept: c.accept,
    reject: c.reject,
    customize: c.customize,
    region: c.region,
    close: c.close,
  });
  json.center.rejectAll = c.reject;
  json.center.label.provider = c.provider;
  const storage = json.categories.essential.storage;
  if (!storage.includes(DISMISS_KEY)) {
    if (!storage.includes('vireek-consent-v3')) throw new Error(`${lang}: essential.storage has no vireek-consent-v3`);
    json.categories.essential.storage = storage.replace('vireek-consent-v3', `vireek-consent-v3, ${DISMISS_KEY}`);
  }
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  console.log(`updated ${lang}.json`);
}
