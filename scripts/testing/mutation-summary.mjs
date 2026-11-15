#!/usr/bin/env node
// scripts/testing/mutation-summary.mjs
//
// Turns a Stryker JSON report (mutation.json) into a score table. Used by the manual
// "Mutation testing (pilot)" workflow and by whoever records the baseline in docs/testing/mutation.md.
// There is NO pass/fail gate here: the exit code is 0 whenever the report could be read.
//
// Score formula (same as Stryker): detected / (detected + undetected) * 100
//   detected   = Killed + Timeout
//   undetected = Survived + NoCoverage
//   not counted: CompileError, RuntimeError, Ignored, Pending
//
// Usage: node scripts/testing/mutation-summary.mjs <mutation.json> [--markdown] [--title "text"]
//        With GITHUB_STEP_SUMMARY set and --github-summary, the markdown is appended to that file.

import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const STATUSES = ['Killed', 'Timeout', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Ignored', 'Pending']

export function emptyCounts() {
  return Object.fromEntries([...STATUSES, 'Other'].map((s) => [s, 0]))
}

export function tally(mutants) {
  const counts = emptyCounts()
  for (const m of mutants) counts[STATUSES.includes(m.status) ? m.status : 'Other']++
  return counts
}

export function scoreOf(counts) {
  const detected = counts.Killed + counts.Timeout
  const valid = detected + counts.Survived + counts.NoCoverage
  return { detected, valid, score: valid === 0 ? null : (detected / valid) * 100 }
}

function addCounts(a, b) {
  const out = emptyCounts()
  for (const k of Object.keys(out)) out[k] = a[k] + b[k]
  return out
}

export function summarize(report) {
  const files = Object.entries(report?.files ?? {})
    .map(([path, file]) => {
      const counts = tally(file?.mutants ?? [])
      return { path, counts, ...scoreOf(counts) }
    })
    .sort((x, y) => x.path.localeCompare(y.path))
  const counts = files.reduce((acc, f) => addCounts(acc, f.counts), emptyCounts())
  return { files, total: { counts, ...scoreOf(counts) } }
}

export const formatScore = (score) => (score === null ? 'n/a' : `${score.toFixed(2)}%`)

export function toMarkdown(summary, title = 'Mutation score') {
  const row = (label, r) =>
    `| ${label} | ${formatScore(r.score)} | ${r.counts.Killed} | ${r.counts.Timeout} | ${r.counts.Survived} | ${r.counts.NoCoverage} | ${r.counts.CompileError + r.counts.RuntimeError} | ${r.counts.Ignored} |`
  return [
    `### ${title}`,
    '',
    '| File | Score | Killed | Timeout | Survived | No coverage | Errors | Ignored |',
    '|---|---|---|---|---|---|---|---|',
    ...summary.files.map((f) => row(`\`${f.path}\``, f)),
    row('**Total**', summary.total),
    '',
  ].join('\n')
}

function main(argv) {
  const args = argv.slice(2)
  const file = args.find((a) => !a.startsWith('--'))
  if (!file) {
    console.error('Usage: node scripts/testing/mutation-summary.mjs <mutation.json> [--markdown] [--github-summary] [--title "text"]')
    return 2
  }
  let report
  try {
    report = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    console.error(`Cannot read Stryker report "${file}": ${error.message}`)
    return 2
  }
  const titleIdx = args.indexOf('--title')
  const title = titleIdx >= 0 && args[titleIdx + 1] ? args[titleIdx + 1] : 'Mutation score'
  const summary = summarize(report)
  const markdown = toMarkdown(summary, title)
  if (args.includes('--github-summary') && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
  }
  console.log(args.includes('--markdown') ? markdown : `${title}: ${formatScore(summary.total.score)} (${summary.total.detected}/${summary.total.valid} mutants detected)`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv)
