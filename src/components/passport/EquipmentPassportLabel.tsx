/**
 * QR / NFC identity for the physical machine: preview, print label, download PNG/SVG, write NFC tag.
 */

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Download, Printer, QrCode, Smartphone } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { equipmentTitle, formatPassportCode, passportUrl, type PassportCore } from '@/lib/equipmentPassport';

interface NdefWriter {
  write(message: { records: { recordType: string; data: string }[] }): Promise<void>;
}
type NdefCtor = new () => NdefWriter;

function nfcSupported(): boolean {
  return typeof window !== 'undefined' && 'NDEFReader' in window && window.isSecureContext;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function download(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function EquipmentPassportLabel({ passport }: { passport: Pick<PassportCore, 'code' | 'make' | 'model' | 'equipment_type' | 'serial'> }) {
  const { toast } = useToast();
  const url = passportUrl(passport.code);
  const display = formatPassportCode(passport.code);
  const title = equipmentTitle(passport);
  const [png, setPng] = useState('');
  const [copied, setCopied] = useState(false);
  const [writing, setWriting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, { margin: 1, width: 640, errorCorrectionLevel: 'Q', color: { dark: '#0b1220', light: '#ffffff' } })
      .then((d) => { if (!cancelled) setPng(d); })
      .catch(() => { if (!cancelled) setPng(''); });
    return () => { cancelled = true; };
  }, [url]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('Could not copy the link', 'error');
    }
  };

  const downloadSvg = async () => {
    try {
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'Q' });
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const href = URL.createObjectURL(blob);
      download(href, `vireek-passport-${passport.code}.svg`);
      URL.revokeObjectURL(href);
    } catch {
      toast('Could not generate the SVG', 'error');
    }
  };

  const printLabel = () => {
    if (!png) return;
    const w = window.open('', '_blank', 'width=520,height=420');
    if (!w) {
      toast('Allow pop-ups to print the label', 'error');
      return;
    }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Passport ${escapeHtml(display)}</title>
<style>
@page{size:auto;margin:8mm}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0b1220}
.label{width:70mm;border:0.4mm solid #0b1220;border-radius:3mm;overflow:hidden}
.bar{background:#0b1220;color:#fff;padding:1.6mm 3mm;font-size:6.5pt;font-weight:700;letter-spacing:.18em;text-transform:uppercase}
.row{display:flex;gap:3mm;padding:3mm;align-items:center}
.row img{width:27mm;height:27mm}
.t{font-size:9.5pt;font-weight:700;line-height:1.2}
.s{font-size:7pt;color:#475569;margin-top:1mm}
.c{font-family:ui-monospace,Menlo,monospace;font-size:8pt;font-weight:700;margin-top:2mm}
.f{padding:1.4mm 3mm;border-top:0.3mm solid #cbd5e1;font-size:6pt;color:#475569}
</style></head><body>
<div class="label"><div class="bar">Vireek Equipment Passport</div>
<div class="row"><img src="${png}" alt="QR code"/><div>
<div class="t">${escapeHtml(title)}</div>
<div class="s">${escapeHtml(passport.equipment_type)}${passport.serial ? ' · S/N ' + escapeHtml(passport.serial) : ''}</div>
<div class="c">${escapeHtml(display)}</div></div></div>
<div class="f">Scan for the full service history of this machine.</div></div>
<script>window.onload=function(){setTimeout(function(){window.print()},150)}<\/script></body></html>`);
    w.document.close();
  };

  const writeNfc = async () => {
    const Ctor = (window as unknown as { NDEFReader?: NdefCtor }).NDEFReader;
    if (!Ctor) return;
    setWriting(true);
    try {
      await new Ctor().write({ records: [{ recordType: 'url', data: url }] });
      toast('NFC tag written — tap it with a phone to test', 'success');
    } catch {
      toast('Could not write the tag. Hold it against the back of the phone and try again.', 'error');
    } finally {
      setWriting(false);
    }
  };

  const btn = 'focus-ring inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50';

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark" aria-labelledby="passport-label">
      <h2 id="passport-label" className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
        <QrCode size={16} className="text-accent" aria-hidden="true" /> Machine label (QR / NFC)
      </h2>
      <div className="mx-auto flex h-44 w-44 items-center justify-center rounded-xl bg-white p-2">
        {png ? <img src={png} alt={`QR code for passport ${display}`} className="h-full w-full" /> : <div className="h-full w-full animate-pulse rounded bg-bg-tertiary" aria-busy="true" />}
      </div>
      <p className="mt-2 text-center font-mono text-xs font-semibold text-text-primary">{display}</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" onClick={printLabel} disabled={!png} className={btn}><Printer size={13} aria-hidden="true" /> Print label</button>
        <button type="button" onClick={() => png && download(png, `vireek-passport-${passport.code}.png`)} disabled={!png} className={btn}><Download size={13} aria-hidden="true" /> PNG</button>
        <button type="button" onClick={downloadSvg} className={btn}><Download size={13} aria-hidden="true" /> SVG (engraving)</button>
        <button type="button" onClick={copy} className={btn}>{copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />} {copied ? 'Copied' : 'Copy link'}</button>
      </div>
      {nfcSupported() ? (
        <button type="button" onClick={writeNfc} disabled={writing} className={`${btn} mt-2 w-full`}>
          <Smartphone size={13} aria-hidden="true" /> {writing ? 'Hold the tag to the phone…' : 'Write to NFC tag'}
        </button>
      ) : (
        <p className="mt-3 text-[11px] text-text-secondary">
          NFC: write the copied link to any NTAG213/215 sticker as a URL record (Android Chrome can do this directly from this button).
        </p>
      )}
    </section>
  );
}
