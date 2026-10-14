/** Pure CSV parsing for utility bills (no I/O, unit-tested). */

export interface UsageDraft {
  period_start: string;
  period_end: string;
  usage: number;
  cost_cents: number | null;
}

function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === delim && !quoted) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function toIso(raw: string): string | null {
  const s = raw.trim();
  let y: number;
  let m: number;
  let d: number;
  let hit = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (hit) [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  else if ((hit = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)))
    [m, d, y] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  else return null;
  const t = Date.UTC(y, m - 1, d);
  const chk = new Date(t);
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== m - 1 || chk.getUTCDate() !== d)
    return null;
  return chk.toISOString().slice(0, 10);
}

/** Columns: period_start, period_end, usage, [cost in dollars]. Header optional; , ; or tab delimited. */
export function parseUsageCsv(text: string): { rows: UsageDraft[]; errors: string[] } {
  const rows: UsageDraft[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  const first = lines.find((l) => l.trim() !== '') ?? '';
  const delim = ['\t', ';', ',']
    .map((d) => ({ d, n: first.split(d).length }))
    .sort((a, b) => b.n - a.n)[0].d;
  lines.forEach((line, idx) => {
    if (line.trim() === '') return;
    const no = idx + 1;
    const cells = splitLine(line, delim);
    if (cells.length < 3)
      return void errors.push(`Line ${no}: expected period_start, period_end, usage[, cost].`);
    if (idx === 0 && toIso(cells[0]) === null && /[a-z]/i.test(cells[0])) return; // header
    const start = toIso(cells[0]);
    const end = toIso(cells[1]);
    if (!start || !end)
      return void errors.push(`Line ${no}: dates must be YYYY-MM-DD or MM/DD/YYYY.`);
    const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
    if (!(days >= 1 && days <= 70))
      return void errors.push(`Line ${no}: the period must be between 1 and 70 days.`);
    const usage = Number(cells[2].replace(/[,\s]/g, ''));
    if (!Number.isFinite(usage) || usage < 0)
      return void errors.push(`Line ${no}: usage must be a non-negative number.`);
    let cost: number | null = null;
    if (cells[3] !== undefined && cells[3] !== '') {
      const dollars = Number(cells[3].replace(/[$,\s]/g, ''));
      if (!Number.isFinite(dollars) || dollars < 0)
        return void errors.push(`Line ${no}: cost must be a non-negative amount.`);
      cost = Math.round(dollars * 100);
    }
    rows.push({ period_start: start, period_end: end, usage, cost_cents: cost });
  });
  return { rows, errors };
}
