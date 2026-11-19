// supabase/functions/_shared/fm-ingest/pdf.ts
//
// Static, pure inspection of an uploaded PDF BEFORE it is stored or handed to a text extractor.
// It never renders or executes anything. It is a heuristic gate, not a malware scanner:
//   * header / trailer / size / encryption checks are exact;
//   * the active-content scan reads PDF *name tokens* in the raw bytes (with #xx escapes decoded),
//     so it cannot see names that live inside compressed object streams.
// That residual is why stored originals are only ever served as a download (never rendered inline) and why
// the extractor must not execute scripts (pdf.js-style text extraction does not).

export const PDF_MAX_BYTES = 8 * 1024 * 1024;
export const PDF_MAX_PAGES = 40;
/** Fewer extracted characters than this means a scanned/image-only PDF: we do not OCR it. */
export const PDF_MIN_TEXT_CHARS = 40;

export type PdfRejectCode = 'empty' | 'too_large' | 'not_pdf' | 'truncated' | 'encrypted' | 'active_content' | 'embedded_files';
export type PdfVerdict = { ok: true; version: string } | { ok: false; code: PdfRejectCode; message: string };

const ACTIVE_NAMES = new Set(['javascript', 'js', 'launch', 'openaction', 'submitform', 'importdata', 'richmedia', 'gotoe', 'gotor', 'sound', 'movie']);
const EMBED_NAMES = new Set(['embeddedfile', 'embeddedfiles', 'filespec']);

function decodeName(raw: string): string {
  return raw.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).toLowerCase();
}

export function inspectPdf(bytes: Uint8Array, maxBytes = PDF_MAX_BYTES): PdfVerdict {
  if (bytes.length === 0) return { ok: false, code: 'empty', message: 'The file is empty.' };
  if (bytes.length > maxBytes) return { ok: false, code: 'too_large', message: `The PDF is larger than ${Math.round(maxBytes / 1_048_576)} MB.` };

  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 16));
  const m = head.match(/^%PDF-([12]\.\d)/);
  if (!m) return { ok: false, code: 'not_pdf', message: 'This is not a PDF file.' };

  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  if (!tail.includes('%%EOF')) return { ok: false, code: 'truncated', message: 'The PDF looks incomplete (no end-of-file marker).' };

  const body = new TextDecoder('latin1').decode(bytes);
  for (const nm of body.matchAll(/\/([^\s/<>[\](){}%]{1,64})/g)) {
    const name = decodeName(nm[1]);
    if (name === 'encrypt') return { ok: false, code: 'encrypted', message: 'The PDF is password-protected or encrypted.' };
    if (ACTIVE_NAMES.has(name)) return { ok: false, code: 'active_content', message: 'The PDF contains scripts or actions, so it was not accepted.' };
    if (EMBED_NAMES.has(name)) return { ok: false, code: 'embedded_files', message: 'The PDF contains embedded files, so it was not accepted.' };
  }
  return { ok: true, version: m[1] };
}

/** Plug-point so the edge function can use a real extractor while tests use a stub. */
export type PdfTextExtractor = (bytes: Uint8Array) => Promise<{ text: string; pages: number }>;

// ---------------------------------------------------------------- text-item joining

export interface PdfTextItemLike { str?: unknown; transform?: unknown; width?: unknown; hasEOL?: unknown }

/**
 * Turns pdf.js-style text items into lines. A new line starts when the baseline moves (> 2 units) or the item
 * ends a line; a gap between items on one line becomes one space (two for a wide, column-like gap) so
 * "Label:  value" pairs stay readable for the Guard parser.
 */
export function joinPdfTextItems(items: readonly PdfTextItemLike[]): string {
  const lines: string[] = [];
  let line = '';
  let lastY: number | null = null;
  let lastEnd: number | null = null;
  let lastEol = false;
  const flush = () => { lines.push(line.replace(/[ \t]+$/g, '')); line = ''; lastEnd = null; };

  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const tr = Array.isArray(it.transform) ? it.transform : [];
    const x = typeof tr[4] === 'number' ? tr[4] : null;
    const y = typeof tr[5] === 'number' ? tr[5] : null;
    const w = typeof it.width === 'number' ? it.width : 0;
    if (lastY !== null && y !== null && (Math.abs(y - lastY) > 2 || lastEol)) flush();
    else if (lastEol) flush();
    if (x !== null && lastEnd !== null && line !== '' && !line.endsWith(' ') && !it.str.startsWith(' ')) {
      const gap = x - lastEnd;
      if (gap > 20) line += '  '; else if (gap > 1.5) line += ' ';
    }
    line += it.str;
    if (y !== null) lastY = y;
    lastEnd = x !== null ? x + w : null;
    lastEol = it.hasEOL === true;
  }
  if (line !== '') flush();
  return lines.join('\n');
}
