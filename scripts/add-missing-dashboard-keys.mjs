#!/usr/bin/env node
// One-time, idempotent: adds the 13 `dashboard` keys that exist in English but not in the other 8 locales
// (pwa.install.*, nav.items.recall_center, nav.mobile.*). Safe to re-run (only adds missing keys, never overwrites).
// MACHINE-DRAFTED translations: have a native speaker review ar, fa, hi, ja, zh before launch (see BRAND_GOVERNANCE.md).
// Refuses to rewrite a file unless JSON.stringify(parse(file), null, 2) reproduces it byte-for-byte (no formatting noise).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const K = ['pwa.install.title', 'pwa.install.body', 'pwa.install.iosSteps', 'pwa.install.cta', 'pwa.install.howTo', 'pwa.install.dismiss', 'nav.items.recall_center', 'nav.mobile.bottomNavigation', 'nav.mobile.overview', 'nav.mobile.jobs', 'nav.mobile.calls', 'nav.mobile.inbox', 'nav.mobile.more'];
const T = {
  es: ['Instala Vireek', 'Añade Vireek a tu pantalla de inicio para acceder con un toque, usarlo a pantalla completa y trabajar sin conexión.', 'Toca el botón Compartir y elige «Añadir a pantalla de inicio».', 'Instalar', 'Cómo instalar', 'Ahora no', 'Centro de retiradas', 'Navegación móvil', 'Resumen', 'Trabajos', 'Llamadas', 'Bandeja de entrada', 'Más'],
  fr: ['Installer Vireek', 'Ajoutez Vireek à votre écran d’accueil pour un accès en un geste, un affichage plein écran et un fonctionnement hors ligne.', 'Touchez le bouton Partager, puis choisissez « Sur l’écran d’accueil ».', 'Installer', 'Comment installer', 'Pas maintenant', 'Centre des rappels', 'Navigation mobile', 'Vue d\'ensemble', 'Travaux', 'Appels', 'Boîte de réception', 'Plus'],
  de: ['Vireek installieren', 'Fügen Sie Vireek Ihrem Home-Bildschirm hinzu – für Zugriff mit einem Tipp, Vollbild und Offline-Nutzung.', 'Tippen Sie auf „Teilen“ und wählen Sie „Zum Home-Bildschirm“.', 'Installieren', 'So installieren Sie die App', 'Nicht jetzt', 'Rückrufzentrale', 'Mobile Navigation', 'Übersicht', 'Aufträge', 'Anrufe', 'Posteingang', 'Mehr'],
  ar: ['ثبّت Vireek', 'أضف Vireek إلى الشاشة الرئيسية للوصول بلمسة واحدة والاستخدام بملء الشاشة والعمل دون اتصال.', 'اضغط على زر المشاركة ثم اختر «إضافة إلى الشاشة الرئيسية».', 'تثبيت', 'كيفية التثبيت', 'ليس الآن', 'مركز الاستدعاءات', 'التنقل في الجوال', 'نظرة عامة', 'الأعمال', 'المكالمات', 'صندوق الوارد', 'المزيد'],
  fa: ['نصب Vireek', 'Vireek را به صفحه اصلی خود اضافه کنید تا با یک ضربه باز شود، تمام‌صفحه کار کند و آفلاین هم در دسترس باشد.', 'روی دکمه اشتراک‌گذاری بزنید و «افزودن به صفحه اصلی» را انتخاب کنید.', 'نصب', 'راهنمای نصب', 'حالا نه', 'مرکز فراخوان‌ها', 'ناوبری موبایل', 'نمای کلی', 'کارها', 'تماس‌ها', 'صندوق ورودی', 'بیشتر'],
  hi: ['Vireek इंस्टॉल करें', 'एक टैप में खोलने, फ़ुल-स्क्रीन में चलाने और ऑफ़लाइन उपयोग के लिए Vireek को होम स्क्रीन पर जोड़ें।', 'शेयर बटन पर टैप करें, फिर “होम स्क्रीन पर जोड़ें” चुनें।', 'इंस्टॉल करें', 'इंस्टॉल कैसे करें', 'अभी नहीं', 'रिकॉल सेंटर', 'मोबाइल नेविगेशन', 'अवलोकन', 'काम', 'कॉल', 'इनबॉक्स', 'और'],
  ja: ['Vireekをインストール', 'Vireekをホーム画面に追加すると、ワンタップで起動でき、全画面表示やオフライン利用も可能になります。', '共有ボタンをタップし、「ホーム画面に追加」を選びます。', 'インストール', 'インストール方法', '今はしない', 'リコールセンター', 'モバイルナビゲーション', '概要', 'ジョブ', '通話', '受信トレイ', 'その他'],
  zh: ['安装 Vireek', '将 Vireek 添加到主屏幕，即可一键打开、全屏使用并支持离线。', '点按“分享”按钮，然后选择“添加到主屏幕”。', '安装', '安装方法', '暂不', '召回中心', '移动导航', '概览', '工单', '通话', '收件箱', '更多'],
};
const setPath = (o, path, v) => { const p = path.split('.'); let c = o; for (const k of p.slice(0, -1)) c = c[k] ??= {}; if (c[p.at(-1)] === undefined) { c[p.at(-1)] = v; return true; } return false; };
for (const [lang, vals] of Object.entries(T)) {
  const file = `${ROOT}src/locales/${lang}/dashboard.json`;
  const raw = fs.readFileSync(file, 'utf8');
  const bom = raw.charCodeAt(0) === 0xfeff; const text = bom ? raw.slice(1) : raw;
  const crlf = text.includes('\r\n'); const lf = text.replace(/\r\n/g, '\n');
  const json = JSON.parse(lf);
  if (`${JSON.stringify(json, null, 2)}\n` !== lf && JSON.stringify(json, null, 2) !== lf) throw new Error(`${lang}: formatting would change on rewrite — aborting (edit by hand).`);
  let added = 0; K.forEach((k, i) => { if (setPath(json, k, vals[i])) added++; });
  if (!added) { console.log(lang, 'already complete'); continue; }
  let out = JSON.stringify(json, null, 2) + (lf.endsWith('\n') ? '\n' : '');
  if (crlf) out = out.replace(/\n/g, '\r\n');
  JSON.parse(out.replace(/^\uFEFF/, ''));
  fs.writeFileSync(file, (bom ? '\uFEFF' : '') + out);
  console.log(lang, `+${added} keys`);
}
