#!/usr/bin/env node
// Adds graceBanner / graceReview / graceUntil to src/locales/*/legalAcceptance.json (idempotent, text insertion so
// existing escapes and formatting stay untouched). Run from the repo root: node scripts/legal/add-grace-locale-keys.mjs
// [COUNSEL] every string is a machine-assisted draft and must be reviewed by a native legal reviewer before launch.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const T = {
  en: ['Updated legal terms take effect for your account on {{date}}. Review and accept them before then to keep using Vireek without interruption.', 'Review and accept', 'You can keep using Vireek until {{date}}. After that date you must accept the update to continue.'],
  fa: ['شرایط حقوقی به‌روزشده از تاریخ {{date}} برای حساب شما اعمال می‌شود. برای ادامهٔ بدون وقفهٔ استفاده از Vireek، پیش از آن تاریخ آن‌ها را بررسی و بپذیرید.', 'بررسی و پذیرش', 'تا تاریخ {{date}} می‌توانید به استفاده از Vireek ادامه دهید. پس از آن، برای ادامه باید به‌روزرسانی را بپذیرید.'],
  ar: ['تسري الشروط القانونية المحدّثة على حسابك اعتبارًا من {{date}}. راجعها ووافق عليها قبل ذلك التاريخ لمواصلة استخدام Vireek دون انقطاع.', 'المراجعة والموافقة', 'يمكنك مواصلة استخدام Vireek حتى {{date}}. بعد هذا التاريخ يجب قبول التحديث للمتابعة.'],
  de: ['Die aktualisierten Rechtsbedingungen gelten ab dem {{date}} für Ihr Konto. Prüfen und akzeptieren Sie sie bis dahin, um Vireek ohne Unterbrechung weiter zu nutzen.', 'Prüfen und akzeptieren', 'Sie können Vireek bis zum {{date}} weiter nutzen. Danach müssen Sie die Aktualisierung akzeptieren, um fortzufahren.'],
  es: ['Las condiciones legales actualizadas entrarán en vigor para su cuenta el {{date}}. Revíselas y acéptelas antes de esa fecha para seguir usando Vireek sin interrupciones.', 'Revisar y aceptar', 'Puede seguir usando Vireek hasta el {{date}}. Después de esa fecha deberá aceptar la actualización para continuar.'],
  fr: ["Les conditions juridiques mises à jour s'appliqueront à votre compte à compter du {{date}}. Consultez-les et acceptez-les avant cette date pour continuer à utiliser Vireek sans interruption.", 'Consulter et accepter', "Vous pouvez continuer à utiliser Vireek jusqu'au {{date}}. Après cette date, vous devrez accepter la mise à jour pour continuer."],
  hi: ['अद्यतन की गई कानूनी शर्तें {{date}} से आपके खाते पर लागू होंगी। Vireek का निर्बाध उपयोग जारी रखने के लिए उस तारीख से पहले इन्हें पढ़ें और स्वीकार करें।', 'देखें और स्वीकार करें', 'आप {{date}} तक Vireek का उपयोग जारी रख सकते हैं। उसके बाद जारी रखने के लिए आपको अपडेट स्वीकार करना होगा।'],
  ja: ['更新された法的条件は {{date}} からお客様のアカウントに適用されます。中断なく Vireek をご利用いただくため、それまでに内容を確認して同意してください。', '確認して同意する', '{{date}} まで Vireek をご利用いただけます。それ以降は、更新内容に同意しないと続行できません。'],
  zh: ['更新后的法律条款将于 {{date}} 起对您的账户生效。请在此日期前查看并接受，以便不间断地继续使用 Vireek。', '查看并接受', '您可以在 {{date}} 之前继续使用 Vireek。此后需接受更新才能继续使用。'],
};

for (const [lng, [banner, review, until]] of Object.entries(T)) {
  const file = join('src/locales', lng, 'legalAcceptance.json');
  const text = readFileSync(file, 'utf8');
  if (text.includes('"graceBanner"')) { console.log(`${lng}: already present`); continue; }
  const m = text.match(/(\n  "signOut": "(?:[^"\\]|\\.)*")(\n\})\s*$/);
  if (!m) { console.error(`${lng}: unexpected file layout, nothing changed`); process.exitCode = 1; continue; }
  const add = `,\n  "graceBanner": ${JSON.stringify(banner)},\n  "graceReview": ${JSON.stringify(review)},\n  "graceUntil": ${JSON.stringify(until)}`;
  writeFileSync(file, text.replace(m[0], m[1] + add + m[2] + '\n'));
  JSON.parse(readFileSync(file, 'utf8'));
  console.log(`${lng}: added`);
}
