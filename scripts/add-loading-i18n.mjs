#!/usr/bin/env node
// scripts/add-loading-i18n.mjs — adds/updates the "loading" block in every src/locales/<lang>/common.json.
// Idempotent, keeps existing formatting (text insertion, no re-serialisation). Run: node scripts/add-loading-i18n.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEYS = ['route', 'pickingUp', 'connecting', 'slow', 'timeout', 'error', 'retry', 'processing', 'refreshing'];
const T = {
  en: ['Loading', 'Picking up…', 'Connecting your calls…', 'Still working…', 'This is taking longer than expected.', 'Something went wrong.', 'Try again', 'Processing…', 'Refreshing…'],
  es: ['Cargando', 'Contestando…', 'Conectando tus llamadas…', 'Sigue en proceso…', 'Esto está tardando más de lo esperado.', 'Algo salió mal.', 'Reintentar', 'Procesando…', 'Actualizando…'],
  fr: ['Chargement', 'Décroche…', 'Connexion de vos appels…', 'Toujours en cours…', 'Cela prend plus de temps que prévu.', 'Une erreur s’est produite.', 'Réessayer', 'Traitement en cours…', 'Actualisation…'],
  de: ['Wird geladen', 'Nimmt ab…', 'Ihre Anrufe werden verbunden…', 'Läuft noch…', 'Das dauert länger als erwartet.', 'Etwas ist schiefgelaufen.', 'Erneut versuchen', 'Wird verarbeitet…', 'Wird aktualisiert…'],
  zh: ['加载中', '正在接听…', '正在连接您的来电…', '仍在处理中…', '耗时比预期更长。', '出了点问题。', '重试', '处理中…', '刷新中…'],
  ja: ['読み込み中', '応答しています…', '通話を接続しています…', '処理を続けています…', '想定より時間がかかっています。', '問題が発生しました。', '再試行', '処理中…', '更新中…'],
  hi: ['लोड हो रहा है', 'कॉल उठा रहे हैं…', 'आपकी कॉल जोड़ी जा रही हैं…', 'अभी भी काम जारी है…', 'उम्मीद से ज़्यादा समय लग रहा है।', 'कुछ गलत हो गया।', 'फिर कोशिश करें', 'प्रोसेस हो रहा है…', 'रीफ़्रेश हो रहा है…'],
  ar: ['جارٍ التحميل', 'جارٍ الرد…', 'جارٍ ربط مكالماتك…', 'لا يزال العمل جارياً…', 'يستغرق هذا وقتاً أطول من المتوقع.', 'حدث خطأ ما.', 'حاول مرة أخرى', 'جارٍ المعالجة…', 'جارٍ التحديث…'],
  fa: ['در حال بارگذاری', 'در حال پاسخ‌گویی…', 'در حال اتصال تماس‌های شما…', 'هنوز در حال انجام است…', 'این کار بیشتر از انتظار طول کشیده است.', 'مشکلی پیش آمد.', 'تلاش مجدد', 'در حال پردازش…', 'در حال به‌روزرسانی…'],
};

const dir = join(process.cwd(), 'src', 'locales');
for (const code of readdirSync(dir)) {
  const file = join(dir, code, 'common.json');
  if (!existsSync(file)) continue;
  const values = T[code] ?? T.en;
  const block = `  "loading": {\n${KEYS.map((k, i) => `    "${k}": ${JSON.stringify(values[i])}`).join(',\n')}\n  },\n`;
  let text = readFileSync(file, 'utf8');
  text = text.replace(/\n  "loading": \{[^}]*\},?[ \t]*(?=\n)/, ''); // drop previous block (idempotent)
  const open = text.indexOf('{');
  text = `${text.slice(0, open + 1)}\n${block.replace(/\n$/, '')}${text.slice(open + 1).replace(/^\n?/, '\n')}`;
  JSON.parse(text); // throws if we broke the file
  writeFileSync(file, text);
  console.log(`✓ ${code}`);
}
