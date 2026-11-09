// Candidate-name intake for the naming screen. Pure: text in, validated names + rejections out.
// Accepts JSON (array of strings / {name} objects / {names: [...]}), CSV, or one name per line.

export const MIN_LEN = 4;
export const MAX_LEN = 8;
export const MAX_NAMES = 200;

/** Lower-case, strip accents. `changed` is true when accents/compat characters were folded. */
export function normalizeName(raw) {
  const original = String(raw ?? '').trim();
  const name = original
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  return { original, name, changed: name !== original.toLowerCase() };
}

/** @returns {string|null} rejection reason, or null when the name is acceptable. */
export function validateName(name) {
  if (!name) return 'empty';
  if (!/^[a-z]+$/.test(name)) return 'letters a-z only (accents are folded; digits, spaces and symbols are rejected)';
  if (name.length < MIN_LEN) return `shorter than ${MIN_LEN} letters`;
  if (name.length > MAX_LEN) return `longer than ${MAX_LEN} letters`;
  return null;
}

/** Minimal RFC-4180 style CSV parser (quotes, doubled quotes, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function rawFromJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Input is not valid JSON: ${err.message}`);
  }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.names) ? data.names : null;
  if (!list) throw new Error('JSON input must be an array or an object with a "names" array');
  return list.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object' && typeof item.name === 'string') return item.name;
    return { invalid: item };
  });
}

function rawFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((c) => c.trim().toLowerCase());
  const named = header.findIndex((c) => ['name', 'names', 'candidate'].includes(c));
  const hasHeader = named !== -1 || ['name', 'names', 'candidate'].includes(header[0]);
  const col = named !== -1 ? named : 0;
  return (hasHeader ? rows.slice(1) : rows).map((r) => r[col] ?? '');
}

/**
 * @param {string} text file contents
 * @param {'json'|'csv'|'auto'} [format]
 * @returns {{accepted: {name: string, original: string, normalized: boolean}[],
 *            rejected: {input: string, reason: string}[], duplicates: string[]}}
 */
export function parseCandidates(text, format = 'auto') {
  const trimmed = String(text ?? '').trim();
  const kind = format === 'auto' ? (/^[[{]/.test(trimmed) ? 'json' : 'csv') : format;
  const raw = kind === 'json' ? rawFromJson(trimmed) : rawFromCsv(trimmed);
  if (raw.length > MAX_NAMES) {
    throw new Error(`Too many candidates (${raw.length}); the limit is ${MAX_NAMES} per run (RDAP politeness).`);
  }
  const accepted = [];
  const rejected = [];
  const duplicates = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') {
      rejected.push({ input: JSON.stringify(item.invalid) ?? 'undefined', reason: 'not a string or {name} object' });
      continue;
    }
    const n = normalizeName(item);
    const reason = validateName(n.name);
    if (reason) rejected.push({ input: n.original, reason });
    else if (seen.has(n.name)) duplicates.push(n.name);
    else {
      seen.add(n.name);
      accepted.push({ name: n.name, original: n.original, normalized: n.changed });
    }
  }
  return { accepted, rejected, duplicates };
}
