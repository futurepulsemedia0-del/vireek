// Tests for scripts/product/prioritize.mjs. No network, no database.
// Run: node --test scripts/product/prioritize.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CsvError, REQUIRED_COLUMNS, csvCell, main, parseArgs, parseCsv, parseItems, rankItems, render, renderMarkdown, scoreOf,
} from './prioritize.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TODAY = '2026-11-19'
const HEADER = 'id,title,owner,reach,impact,confidence,effort,gate,evidence,scored_on'
const csv = (...rows) => [HEADER, ...rows].join('\n')
const quote = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
const row = (id, reach, impact, conf, effort, extra = {}) =>
  [id, quote(extra.title ?? `Item ${id}`), 'product', reach, impact, conf, effort, extra.gate ?? '', extra.evidence ?? (conf >= 80 ? 'interviews' : ''), extra.scored ?? TODAY].join(',')
const rank = (...rows) => {
  const r = parseItems(csv(...rows), { today: TODAY })
  assert.deepEqual(r.errors, [])
  return rankItems(r.items)
}
const ids = (ranked) => ranked.map((r) => r.id)

// ---- CSV parsing -----------------------------------------------------------------------------------------------
test('parseCsv: quotes, doubled quotes, CRLF, CR, BOM, embedded newline, blank lines', () => {
  const out = parseCsv('\uFEFFa,b\r\n"x, y","say ""hi"""\r\n\r\n"two\nlines",z\rlast,row')
  assert.deepEqual(out.map((r) => r.cells), [['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', 'z'], ['last', 'row']])
  assert.deepEqual(out.map((r) => r.line), [1, 2, 4, 6])
})

test('parseCsv: keeps empty cells and a final record without trailing newline', () => {
  assert.deepEqual(parseCsv('a,,c\n,,').map((r) => r.cells), [['a', '', 'c'], ['', '', '']])
})

test('parseCsv: rejects an unterminated quote, text after a closing quote and a stray quote', () => {
  assert.throws(() => parseCsv('a,"open\nb'), (e) => e instanceof CsvError && /unterminated/.test(e.message) && /line 1/.test(e.message))
  assert.throws(() => parseCsv('"a"b,c'), /text after a closing quote/)
  assert.throws(() => parseCsv('ab"c,d'), /unexpected quote/)
})

// ---- Scoring ---------------------------------------------------------------------------------------------------
test('score = reach x impact x confidence / effort, exactly', () => {
  const [a] = rank(row('A', 100, 2, 80, 2))
  assert.equal(a.score, 80)
  assert.equal(scoreOf(a), 80)
  const [b] = rank(row('B', 120, 1, 80, 3))
  assert.equal(b.score, 32)
  const [c] = rank(row('C', 7, 0.25, 50, 0.5))
  assert.equal(c.score, 1.75)
  assert.equal(`${c.num}/${c.den}`, '350/200') // (7 x 1 quarter x 50) / (200 x 1 half-week)
})

test('accepts "80%", "1.0" and surrounding spaces; effort in 0.5 steps', () => {
  const r = parseItems(csv(' A , Title ,product, 10 ,1.0, 80% ,1.5,,source,' + TODAY), { today: TODAY })
  assert.deepEqual(r.errors, [])
  assert.equal(r.items[0].confidence, 80)
  assert.equal(r.items[0].impact, 1)
  assert.equal(r.items[0].id, 'A')
})

// ---- Tie-break rules -------------------------------------------------------------------------------------------
test('ordering is by score, descending', () => {
  assert.deepEqual(ids(rank(row('low', 10, 1, 50, 5), row('high', 500, 3, 100, 1), row('mid', 100, 1, 80, 2))), ['high', 'mid', 'low'])
})

test('exact tie 1: higher confidence wins', () => {
  const r = rank(row('guess', 80, 1, 50, 2), row('proven', 40, 1, 100, 2)) // both 20
  assert.deepEqual(ids(r), ['proven', 'guess'])
  assert.equal(r[0].score, r[1].score)
  assert.equal(r[1].tieBreak, 'confidence')
})

test('exact tie 2: lower effort wins when confidence is equal', () => {
  const r = rank(row('big', 20, 1, 80, 2), row('small', 10, 1, 80, 1)) // both 8
  assert.deepEqual(ids(r), ['small', 'big'])
  assert.equal(r[1].tieBreak, 'effort')
})

test('exact tie 3: higher reach wins when confidence and effort are equal', () => {
  const r = rank(row('narrow', 50, 2, 80, 2), row('wide', 100, 1, 80, 2)) // both 40
  assert.deepEqual(ids(r), ['wide', 'narrow'])
  assert.equal(r[1].tieBreak, 'reach')
})

test('exact tie 4: identical numbers fall back to id in natural order, case-insensitive', () => {
  const r = rank(row('item-10', 10, 1, 80, 1), row('Item-2', 10, 1, 80, 1), row('item-1', 10, 1, 80, 1))
  assert.deepEqual(ids(r), ['item-1', 'Item-2', 'item-10'])
  assert.equal(r[1].tieBreak, 'id')
})

test('ties are exact: values that tie only in exact arithmetic are still ties (no float noise)', () => {
  // 3*1*80/1.5 = 160 and 0.25-based 12*0.25*... : compare numerically exact fractions
  const r = rank(row('x', 3, 3, 80, 0.5), row('y', 36, 1, 80, 0.5)) // x: 3*3*.8/.5 = 14.4 ; y: 36*.8/.5 = 57.6 -> not tie
  assert.notEqual(r[0].tieBreak, 'confidence')
  const t = rank(row('p', 9, 1, 80, 1.5), row('q', 6, 1, 80, 1)) // 4.8 and 4.8
  assert.equal(t[1].tieBreak, 'effort')
})

test('input order never changes the result', () => {
  const rows = [row('a', 10, 1, 80, 1), row('b', 10, 1, 80, 1), row('c', 40, 2, 100, 3), row('d', 5, 0.5, 50, 0.5), row('e', 0, 1, 50, 1)]
  const expected = ids(rank(...rows))
  for (const shuffled of [[...rows].reverse(), [rows[2], rows[0], rows[4], rows[1], rows[3]]]) assert.deepEqual(ids(rank(...shuffled)), expected)
})

test('gated items form their own block first, ordered by the same rules', () => {
  const r = rank(row('growth', 1000, 3, 100, 1), row('patch', 1, 0.25, 50, 8, { gate: 'security' }), row('contract', 5, 1, 80, 2, { gate: 'commitment' }))
  assert.deepEqual(ids(r), ['contract', 'patch', 'growth'])
  assert.deepEqual(r.map((x) => x.block), ['gated', 'gated', 'scored'])
  assert.equal(r[2].tieBreak, null) // block boundary is not a tie
})

// ---- Validation ------------------------------------------------------------------------------------------------
test('collects every problem with its line number instead of stopping at the first', () => {
  const r = parseItems(csv(
    'A,Title,product,1.5,1,80,1,,src,' + TODAY,
    'B,Title,product,10,4,80,1,,src,' + TODAY,
    'C,Title,product,10,1,75,1,,src,' + TODAY,
    'D,Title,product,10,1,80,0.3,,src,' + TODAY,
    'E,Title,product,10,1,80,0,,src,' + TODAY,
    'F,Title,,10,1,80,1,,src,' + TODAY,
    'G,Title,product,10,1,80,1,urgent,src,' + TODAY,
  ), { today: TODAY })
  assert.equal(r.items.length, 0)
  assert.equal(r.errors.length, 7)
  assert.match(r.errors[0], /^line 2: reach must be a whole number/)
  assert.match(r.errors[1], /^line 3: impact must be one of 0.25, 0.5, 1, 2, 3/)
  assert.match(r.errors[2], /^line 4: confidence must be one of 50, 80, 100/)
  assert.match(r.errors[3], /^line 5: effort is estimated in steps of 0.5/)
  assert.match(r.errors[4], /^line 6: effort must be greater than 0/)
  assert.match(r.errors[5], /^line 7: owner is required/)
  assert.match(r.errors[6], /^line 8: gate must be one of/)
})

test('rejects thousands separators, decimal commas, percent below the tiers and fractions as confidence', () => {
  const r = parseItems(csv('A,T,p,"1,200",1,0.8,1,,s,' + TODAY), { today: TODAY })
  assert.equal(r.errors.length, 2)
  assert.match(r.errors[0], /reach must be a whole number/)
  assert.match(r.errors[1], /confidence must be one of/)
})

test('confidence 80 and 100 need evidence; 50 does not', () => {
  assert.match(parseItems(csv('A,T,p,1,1,80,1,,,' + TODAY), { today: TODAY }).errors[0], /evidence is required/)
  assert.match(parseItems(csv('A,T,p,1,1,100,1,,   ,' + TODAY), { today: TODAY }).errors[0], /evidence is required/)
  assert.deepEqual(parseItems(csv('A,T,p,1,1,50,1,,,' + TODAY), { today: TODAY }).errors, [])
})

test('duplicate ids are errors, case-insensitively, pointing at the first line', () => {
  const r = parseItems(csv(row('A-1', 1, 1, 50, 1), row('a-1', 2, 1, 50, 1)), { today: TODAY })
  assert.match(r.errors[0], /^line 3: duplicate id "a-1" \(first used on line 2\)/)
})

test('id charset is restricted (no spaces, no formula characters)', () => {
  for (const bad of ['=cmd', '-x', 'has space', '', 'a'.repeat(65)]) {
    const r = parseItems(csv(`${bad || ' '},T,p,1,1,50,1,,,${TODAY}`), { today: TODAY })
    assert.match(r.errors.join(' '), /id must be/, JSON.stringify(bad))
  }
})

test('a row with more cells than the header is an error that explains quoting', () => {
  const r = parseItems(csv(`A,Title, with a comma,p,1,1,50,1,,,${TODAY}`), { today: TODAY })
  assert.match(r.errors[0], /has \d+ cells but the header has 10.*quoted/)
})

test('scored_on: invalid date, future date, stale warning, missing warning', () => {
  const bad = parseItems(csv(row('A', 1, 1, 50, 1, { scored: '2026-02-30' })), { today: TODAY })
  assert.match(bad.errors[0], /real date/)
  const future = parseItems(csv(row('A', 1, 1, 50, 1, { scored: '2026-12-01' })), { today: TODAY })
  assert.match(future.errors[0], /in the future/)
  const stale = parseItems(csv(row('A', 1, 1, 50, 1, { scored: '2026-08-01' })), { today: TODAY })
  assert.deepEqual(stale.errors, [])
  assert.match(stale.warnings[0], /more than 90 days ago: re-score it/)
  const edge = parseItems(csv(row('A', 1, 1, 50, 1, { scored: '2026-08-21' })), { today: TODAY }) // exactly 90 days: still fresh
  assert.deepEqual(edge.warnings, [])
  const custom = parseItems(csv(row('A', 1, 1, 50, 1, { scored: '2026-11-01' })), { today: TODAY, staleDays: 7 })
  assert.match(custom.warnings[0], /more than 7 days ago/)
  const missing = parseItems(csv(row('A', 1, 1, 50, 1, { scored: '' })), { today: TODAY })
  assert.match(missing.warnings[0], /no scored_on/)
})

test('header problems: missing column, duplicate column, unknown column (warning), empty file, no items', () => {
  assert.match(parseItems('id,title\nA,T').errors[0], /missing required column\(s\): owner, reach, impact, confidence, effort/)
  assert.match(parseItems(`${REQUIRED_COLUMNS.join(',')},id\n`).errors[0], /duplicate column "id"/)
  assert.match(parseItems('').errors[0], /empty/)
  assert.match(parseItems(`${REQUIRED_COLUMNS.join(',')}\n`).errors[0], /no items/)
  const unknown = parseItems(`${HEADER},mood\n` + row('A', 1, 1, 50, 1) + ',happy', { today: TODAY })
  assert.deepEqual(unknown.errors, [])
  assert.match(unknown.warnings[0], /unknown column "mood"/)
  assert.match(parseItems('id,title\n"x', {}).errors[0], /unterminated/)
})

test('column order is free and header case is ignored', () => {
  const r = parseItems('Effort,REACH,id,Title,owner,impact,Confidence\n2,100,A,T,p,2,80\n', { today: TODAY })
  assert.equal(r.items.length, 0) // evidence column is missing -> evidence required at 80
  assert.match(r.errors[0], /evidence is required/)
  const ok = parseItems('Effort,REACH,id,Title,owner,impact,Confidence\n2,100,A,T,p,2,50\n', { today: TODAY })
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.items[0].reach, 100)
})

test('zero reach is allowed but warned', () => {
  const r = parseItems(csv(row('Z', 0, 1, 50, 1)), { today: TODAY })
  assert.deepEqual(r.errors, [])
  assert.match(r.warnings[0], /reach 0/)
})

// ---- Output ----------------------------------------------------------------------------------------------------
test('csv output neutralises spreadsheet formulas and quotes correctly', () => {
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)")
  assert.equal(csvCell('+1'), "'+1")
  assert.equal(csvCell('-2'), "'-2")
  assert.equal(csvCell('@x'), "'@x")
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('say "hi"'), '"say ""hi"""')
  const rows = rank(row('A', 10, 1, 80, 1, { title: '=HYPERLINK("http://x")' }))
  const out = render(rows, 'csv').split('\n')
  assert.equal(out[0], 'rank,id,title,owner,gate,reach,impact,confidence,effort,score,tie_break')
  assert.match(out[1], /^1,A,"'=HYPERLINK\(""http:\/\/x""\)",product,none,10,1,80,1,8\.00,$/)
})

test('markdown output escapes pipes and newlines', () => {
  const md = renderMarkdown(rank(row('A', 10, 1, 80, 1, { title: 'a | b' })))
  assert.match(md, /a \\\| b/)
  assert.equal(md.split('\n').filter(Boolean).length, 3)
})

test('json output carries the exact fraction and tie-break', () => {
  const parsed = JSON.parse(render(rank(row('a', 40, 1, 100, 2), row('b', 80, 1, 50, 2)), 'json'))
  assert.equal(parsed[0].id, 'a')
  assert.equal(parsed[1].tieBreak, 'confidence')
  assert.equal(parsed[0].scoreExact, '16000/800') // (40 x 4 quarters x 100) / (200 x 4 half-weeks)
  assert.equal(parsed[0].score, 20)
})

// ---- CLI -------------------------------------------------------------------------------------------------------
function run(argv, input) {
  let out = ''
  let err = ''
  const code = main(argv, {
    stdout: (s) => { out += s },
    stderr: (s) => { err += s },
    readInput: (f) => {
      if (input === undefined) throw Object.assign(new Error('nope'), { code: 'ENOENT' })
      return input
    },
    now: new Date(`${TODAY}T12:00:00Z`),
  })
  return { code, out, err }
}

test('main: ranks and prints, exit 0; warnings go to stderr', () => {
  const r = run(['f.csv', '--format', 'csv'], csv(row('A', 10, 1, 80, 1), row('B', 20, 1, 80, 1, { scored: '' })))
  assert.equal(r.code, 0)
  assert.match(r.out, /^rank,id/)
  assert.match(r.err, /no scored_on/)
})

test('main: --top limits output; --strict turns warnings into a failure with no output', () => {
  const data = csv(row('A', 10, 1, 80, 1), row('B', 20, 1, 80, 1), row('C', 5, 1, 80, 1))
  const top = run(['f.csv', '--top', '2', '--format', 'json'], data)
  assert.equal(JSON.parse(top.out).length, 2)
  const warn = csv(row('A', 10, 1, 80, 1, { scored: '' }))
  assert.equal(run(['f.csv'], warn).code, 0)
  const strict = run(['f.csv', '--strict'], warn)
  assert.equal(strict.code, 1)
  assert.equal(strict.out, '')
})

test('main: invalid data exits 1, prints every error, ranks nothing', () => {
  const r = run(['f.csv'], csv('A,T,p,x,9,1,0,,,'))
  assert.equal(r.code, 1)
  assert.equal(r.out, '')
  assert.match(r.err, /nothing ranked/)
})

test('main: usage problems exit 2', () => {
  assert.equal(run([], 'x').code, 2)
  assert.equal(run(['f.csv', '--format', 'xml'], 'x').code, 2)
  assert.equal(run(['f.csv', '--top', '0'], 'x').code, 2)
  assert.equal(run(['f.csv', '--top'], 'x').code, 2)
  assert.equal(run(['f.csv', '--nope'], 'x').code, 2)
  assert.equal(run(['a.csv', 'b.csv'], 'x').code, 2)
  assert.equal(run(['f.csv', '--stale-days', 'abc'], 'x').code, 2)
  assert.match(run(['missing.csv']).err, /cannot read missing.csv: ENOENT/)
  assert.equal(run(['--help']).code, 0)
})

test('main: --today makes staleness repeatable', () => {
  const data = csv(row('A', 10, 1, 50, 1, { scored: '2026-01-01' }))
  assert.match(run(['f.csv', '--today', '2026-12-31'], data).err, /more than 90 days ago/)
  assert.equal(run(['f.csv', '--today', '2026-01-02'], data).err, '')
  assert.equal(run(['f.csv', '--today', 'yesterday'], data).code, 1)
})

test('parseArgs: stdin marker "-" is a file argument, flags need values', () => {
  assert.equal(parseArgs(['-']).file, '-')
  assert.throws(() => parseArgs(['--format', '--top']), /needs a value/)
})

test('the shipped template stays valid: only the "delete the example rows" warnings', () => {
  const text = readFileSync(join(ROOT, 'docs/product/prioritization-template.csv'), 'utf8')
  const r = parseItems(text, { today: '2026-11-19' })
  assert.deepEqual(r.errors, [])
  assert.equal(r.warnings.length, 2)
  assert.ok(r.warnings.every((w) => /template example row/.test(w)))
  for (const c of REQUIRED_COLUMNS) assert.ok(text.split('\n')[0].split(',').includes(c))
})

test('the CLI entry point runs end to end (child process, real file, exit code)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prioritize-'))
  try {
    const file = join(dir, 'b.csv')
    writeFileSync(file, csv(row('A', 100, 2, 80, 2), row('B', 10, 1, 50, 1)))
    const ok = spawnSync(process.execPath, [join(ROOT, 'scripts/product/prioritize.mjs'), file, '--format', 'json', '--today', TODAY], { encoding: 'utf8' })
    assert.equal(ok.status, 0, ok.stderr)
    assert.deepEqual(JSON.parse(ok.stdout).map((r) => r.id), ['A', 'B'])
    writeFileSync(file, csv('A,T,p,nope,1,50,1,,,'))
    const bad = spawnSync(process.execPath, [join(ROOT, 'scripts/product/prioritize.mjs'), file], { encoding: 'utf8' })
    assert.equal(bad.status, 1)
    assert.equal(spawnSync(process.execPath, [join(ROOT, 'scripts/product/prioritize.mjs'), join(dir, 'gone.csv')], { encoding: 'utf8' }).status, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
