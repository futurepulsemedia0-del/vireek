#!/usr/bin/env node
// One-time script: adds the `format` block (time-zone / clock-style / show-more strings) to
// src/locales/<lng>/dashboard.json for all 9 languages. Safe to re-run (skips files that have it).
// Machine-drafted translations: have a native speaker review ar, fa, hi, ja, zh before launch.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const T = {
 en:["{{business}} (your time {{viewer}})","Show more","Show less","Business time zone","Use each person’s own time zone","Clock style","Match language","12-hour (3:00 PM)","24-hour (15:00)"],
 de:["{{business}} (Ihre Zeit: {{viewer}})","Mehr anzeigen","Weniger anzeigen","Zeitzone des Unternehmens","Zeitzone jeder Person verwenden","Uhrzeitformat","Wie die Sprache","12-Stunden (3:00 PM)","24-Stunden (15:00)"],
 es:["{{business}} (tu hora: {{viewer}})","Mostrar más","Mostrar menos","Zona horaria del negocio","Usar la zona horaria de cada persona","Formato de hora","Según el idioma","12 horas (3:00 p. m.)","24 horas (15:00)"],
 fr:["{{business}} (votre heure : {{viewer}})","Afficher plus","Afficher moins","Fuseau horaire de l’entreprise","Utiliser le fuseau de chaque personne","Format de l’heure","Selon la langue","12 heures (3:00 PM)","24 heures (15:00)"],
 ar:["{{business}} (بتوقيتك: {{viewer}})","عرض المزيد","عرض أقل","المنطقة الزمنية للنشاط","استخدام المنطقة الزمنية لكل شخص","نمط الساعة","حسب اللغة","12 ساعة (3:00 م)","24 ساعة (15:00)"],
 fa:["{{business}} (به وقت شما: {{viewer}})","نمایش بیشتر","نمایش کمتر","منطقه زمانی کسب‌وکار","استفاده از منطقه زمانی هر فرد","قالب ساعت","مطابق زبان","۱۲ ساعته (۳:۰۰ بعدازظهر)","۲۴ ساعته (۱۵:۰۰)"],
 hi:["{{business}} (आपका समय: {{viewer}})","और दिखाएँ","कम दिखाएँ","व्यवसाय का समय क्षेत्र","हर व्यक्ति का अपना समय क्षेत्र इस्तेमाल करें","घड़ी का प्रारूप","भाषा के अनुसार","12-घंटे (3:00 PM)","24-घंटे (15:00)"],
 ja:["{{business}}（お客様の時刻：{{viewer}}）","もっと見る","閉じる","事業所のタイムゾーン","各ユーザーのタイムゾーンを使う","時計の表示形式","言語に合わせる","12時間制（午後3:00）","24時間制（15:00）"],
 zh:["{{business}}（您的时间：{{viewer}}）","显示更多","收起","业务时区","使用每个人自己的时区","时钟格式","跟随语言","12 小时制（下午 3:00）","24 小时制（15:00）"],
};
const K=['zonedPair','showMore','showLess','timeZoneLabel','timeZoneViewer','hourCycleLabel','hourCycleAuto','hourCycle12','hourCycle24'];
const snippets={};
for (const [l,v] of Object.entries(T)) {
  const body = K.map((k,i)=>`    ${JSON.stringify(k)}: ${JSON.stringify(v[i])}`).join(',\n');
  const snip = `  "format": {\n${body}\n  },\n`;
  snippets[l]=snip;
  const p=`${ROOT}src/locales/${l}/dashboard.json`;
  let s=fs.readFileSync(p,'utf8'); if (JSON.parse(s.replace(/^\uFEFF/,'')).format) { console.log(l,'already has format block — skipped'); continue; } const bom=s.charCodeAt(0)===0xFEFF; if(bom) s=s.slice(1);
  const nl = s.includes('\r\n') ? '\r\n' : '\n';
  if(!s.startsWith('{'+nl)) throw new Error(l+' line1 is not "{"');
  s = '{'+nl + snip.replace(/\n/g,nl) + s.slice(('{'+nl).length);
  JSON.parse(s); fs.writeFileSync(p,(bom?'\uFEFF':'')+s);
  console.log(l,'ok', bom?'BOM':'', nl==='\r\n'?'CRLF':'LF');
}
void snippets;
