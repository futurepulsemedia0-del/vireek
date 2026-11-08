#!/usr/bin/env node
// One-shot, idempotent: merges the `motion` block into src/locales/<lng>/common.json for all 9 languages.
import { readFileSync, writeFileSync } from 'node:fs'

const T = {
  en: ['Pause moving content', 'Play moving content'],
  es: ['Pausar el contenido en movimiento', 'Reanudar el contenido en movimiento'],
  fr: ['Mettre en pause le contenu animé', 'Reprendre le contenu animé'],
  de: ['Bewegte Inhalte pausieren', 'Bewegte Inhalte fortsetzen'],
  zh: ['暂停动态内容', '播放动态内容'],
  ja: ['動くコンテンツを一時停止', '動くコンテンツを再生'],
  hi: ['चलती सामग्री रोकें', 'चलती सामग्री चलाएँ'],
  ar: ['إيقاف المحتوى المتحرك مؤقتًا', 'تشغيل المحتوى المتحرك'],
  fa: ['توقف محتوای متحرک', 'پخش محتوای متحرک'],
}

for (const [lng, [pause, play]] of Object.entries(T)) {
  const file = `src/locales/${lng}/common.json`
  const text = readFileSync(file, 'utf8')
  const indent = /\n(\s+)"/.exec(text)?.[1] ?? '  '
  const json = JSON.parse(text)
  json.motion = { pause, play }
  writeFileSync(file, JSON.stringify(json, null, indent) + (text.endsWith('\n') ? '\n' : ''))
  console.log(`${lng}: motion block written`)
}
