import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { formatCents } from '@/lib/quotes';
import {
  PAGE_DIMENSIONS,
  computeTotals,
  formatDocDate,
  isNumericLike,
  pdfSafeText,
  tint,
  visibleSections,
  type DocumentDesign,
  type RenderData,
} from '@/lib/documentTemplates';

/**
 * Instant, approximate preview of a template. 1 CSS px = 1 PDF pt, then the whole sheet is scaled to fit
 * the container. It mirrors the PDF renderer's layout, but page breaks are only decided when the real PDF
 * is generated (use "Download sample PDF" for the exact result).
 */

const FONT_STACK: Record<DocumentDesign['theme']['font'], string> = {
  helvetica: 'Helvetica, Arial, sans-serif',
  times: '"Times New Roman", Times, serif',
  courier: '"Courier New", Courier, monospace',
};

const rgb = (c: [number, number, number]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

export function DocumentPreview({ design, data }: { design: DocumentDesign; data: RenderData }) {
  const { w: PW, h: PH } = PAGE_DIMENSIONS[design.page.size];
  const wrapRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.6);
  const [sheetH, setSheetH] = useState(PH);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const avail = wrap.clientWidth;
      if (avail > 0) setScale(Math.min(1.2, avail / PW));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [PW]);

  useLayoutEffect(() => {
    if (sheetRef.current) setSheetH(Math.max(PH, sheetRef.current.scrollHeight));
  });

  const { theme, header, table } = design;
  const M = design.page.margin;
  const base = theme.baseSize;
  const S = pdfSafeText;
  const money = (c: number) => S(formatCents(c, data.currency));
  const band = header.accentBar === 'band';
  const brandRight = header.logoAlign === 'right';
  const onBand = '#FFFFFF';
  const onBandMuted = rgb(tint(theme.primary, 0.78));
  const tot = computeTotals(data.lineItems, data.taxPercent, data.discountCents, data.taxCentsOverride);
  const logo = header.showLogo ? data.business.logoDataUrl : null;

  const label: CSSProperties = { fontWeight: 700, fontSize: base - 1, color: theme.primary, marginBottom: 6 };
  const mutedSmall: CSSProperties = { color: theme.muted, fontSize: base - 1 };

  const brand = (
    <div style={{ textAlign: brandRight ? 'right' : 'left', maxWidth: '55%' }}>
      {logo && <img src={logo} alt="" style={{ maxHeight: 46, maxWidth: 150, marginBottom: 6, display: 'inline-block' }} />}
      {header.showBusinessName && data.business.name.trim() && (
        <div style={{ fontWeight: 700, fontSize: base + 5, color: band ? onBand : theme.text }}>{S(data.business.name)}</div>
      )}
      {header.tagline && <div style={{ fontSize: base, color: band ? onBandMuted : theme.muted }}>{S(header.tagline)}</div>}
      {header.showBusinessContact &&
        data.business.lines.slice(0, 4).map((l, i) => (
          <div key={i} style={{ fontSize: base - 1, color: band ? onBandMuted : theme.muted }}>
            {S(l)}
          </div>
        ))}
    </div>
  );
  const title = (
    <div style={{ textAlign: brandRight ? 'left' : 'right', maxWidth: '42%' }}>
      {header.title && <div style={{ fontWeight: 700, fontSize: 24, color: band ? onBand : theme.primary }}>{S(header.title)}</div>}
      {data.documentNumber && <div style={{ fontSize: base + 1, color: band ? onBandMuted : theme.muted }}>{S(data.documentNumber)}</div>}
      {data.stamp?.text && (
        <div
          style={{
            fontWeight: 700,
            fontSize: base + 1,
            color: band ? onBand : data.stamp.tone === 'success' ? '#168257' : data.stamp.tone === 'danger' ? '#C83737' : theme.primary,
          }}
        >
          {S(data.stamp.text)}
        </div>
      )}
      {data.docType === 'report' && data.issueDate && (
        <div style={{ fontSize: base, color: band ? onBandMuted : theme.muted }}>{formatDocDate(data.issueDate)}</div>
      )}
    </div>
  );

  const cols: { label: string; w: string; right: boolean }[] =
    data.docType === 'report' && data.report
      ? data.report.columns.slice(0, 8).map((c, i) => ({
          label: c,
          w: i === 0 ? '2fr' : '1fr',
          right: i > 0 && data.report!.rows.length > 0 && data.report!.rows.every((r) => isNumericLike(r[i] ?? '')),
        }))
      : [
          { label: table.descriptionLabel, w: '1fr', right: false },
          ...(table.showQty ? [{ label: table.qtyLabel, w: '56px', right: true }] : []),
          ...(table.showUnitPrice ? [{ label: table.unitLabel, w: '88px', right: true }] : []),
          { label: table.amountLabel, w: '92px', right: true },
        ];
  const rows: string[][] =
    data.docType === 'report' && data.report
      ? data.report.rows.map((r) => cols.map((_, i) => r[i] ?? ''))
      : data.lineItems.map((li) => {
          const q = Number(li.quantity) || 0;
          const u = Number(li.unit_price_cents) || 0;
          return [
            li.description,
            ...(table.showQty ? [q.toLocaleString('en-US', { maximumFractionDigits: 2 })] : []),
            ...(table.showUnitPrice ? [money(u)] : []),
            money(Math.round(q * u)),
          ];
        });
  const grid = cols.map((c) => c.w).join(' ');

  const section = (id: ReturnType<typeof visibleSections>[number]) => {
    switch (id) {
      case 'customer':
        return (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ flex: '0 0 50%' }}>
              <div style={{ ...mutedSmall, fontWeight: 700 }}>{data.docType === 'invoice' ? 'Bill to' : 'Prepared for'}</div>
              <div style={{ fontWeight: 700, fontSize: base + 1, marginTop: 2 }}>{S(data.customer.name) || '—'}</div>
              {data.customer.lines.slice(0, 4).map((l, i) => (
                <div key={i} style={mutedSmall}>
                  {S(l)}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 20 }}>
              <div>
                <div style={{ ...mutedSmall, fontWeight: 700 }}>{data.docType === 'invoice' ? 'Issued' : 'Date'}</div>
                <div style={{ marginTop: 2 }}>{formatDocDate(data.issueDate)}</div>
              </div>
              {data.secondaryDateLabel && (
                <div>
                  <div style={{ ...mutedSmall, fontWeight: 700 }}>{S(data.secondaryDateLabel)}</div>
                  <div style={{ marginTop: 2 }}>{formatDocDate(data.secondaryDate)}</div>
                </div>
              )}
            </div>
          </div>
        );
      case 'summary':
        return data.report ? (
          <div>
            <div style={{ fontWeight: 700, fontSize: base + 5, color: theme.primary }}>{S(data.report.title)}</div>
            {data.report.period && <div style={{ ...mutedSmall, fontSize: base, marginTop: 2 }}>{S(data.report.period)}</div>}
            {data.report.summary && <p style={{ margin: '8px 0 0', lineHeight: 1.4 }}>{S(data.report.summary)}</p>}
          </div>
        ) : null;
      case 'metrics': {
        const m = data.report?.metrics.slice(0, 12) ?? [];
        if (m.length === 0) return null;
        return (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(4, m.length)}, 1fr)`, gap: 10 }}>
            {m.map((x, i) => (
              <div key={i} style={{ background: rgb(tint(theme.primary, 0.93)), borderLeft: `3px solid ${theme.accent}`, padding: '8px 10px' }}>
                <div style={{ fontWeight: 700, fontSize: base + 6, color: theme.primary }}>{S(x.value)}</div>
                <div style={mutedSmall}>{S(x.label)}</div>
              </div>
            ))}
          </div>
        );
      }
      case 'items':
        return (
          <div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: grid,
                background: table.headerStyle === 'filled' ? rgb(tint(theme.primary, 0.9)) : undefined,
                borderBottom: table.headerStyle === 'underline' ? `1px solid ${theme.primary}` : undefined,
                color: table.headerStyle === 'filled' ? theme.primary : theme.muted,
                fontWeight: 700,
                fontSize: base - 1,
              }}
            >
              {cols.map((c, i) => (
                <div key={i} style={{ padding: '6px 8px', textAlign: c.right ? 'right' : 'left' }}>
                  {S(c.label)}
                </div>
              ))}
            </div>
            {rows.length === 0 && <div style={{ padding: '8px', ...mutedSmall }}>Nothing to show.</div>}
            {rows.map((r, ri) => (
              <div
                key={ri}
                style={{
                  display: 'grid',
                  gridTemplateColumns: grid,
                  background: table.zebra && ri % 2 === 1 ? 'rgb(247,247,250)' : undefined,
                  borderBottom: table.zebra ? undefined : '0.5px solid rgb(225,225,232)',
                }}
              >
                {r.map((cell, i) => (
                  <div key={i} style={{ padding: '6px 8px', textAlign: cols[i]?.right ? 'right' : 'left', overflowWrap: 'anywhere' }}>
                    {S(cell) || '—'}
                  </div>
                ))}
              </div>
            ))}
          </div>
        );
      case 'totals': {
        if (data.docType === 'report') return null;
        const t = design.totals;
        const pct = data.taxPercent > 0 ? ` (${data.taxPercent}%)` : '';
        const line = (l: string, v: string) => (
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 8px 2px 0' }}>
            <span>{S(l)}</span>
            <span>{S(v)}</span>
          </div>
        );
        return (
          <div style={{ marginLeft: 'auto', width: 230 }}>
            {t.showSubtotal && line('Subtotal', money(tot.subtotalCents))}
            {t.showDiscount && tot.discountCents > 0 && line('Discount', `-${money(tot.discountCents)}`)}
            {t.showTax && (tot.taxCents > 0 || data.taxPercent > 0) && line(`Tax${pct}`, money(tot.taxCents))}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                borderTop: `1.2px solid ${theme.primary}`,
                marginTop: 4,
                padding: '8px 8px 0 0',
                fontWeight: 700,
                fontSize: base + 2,
              }}
            >
              <span>{S(t.totalLabel)}</span>
              <span style={{ color: theme.primary, fontSize: base + 3 }}>{money(tot.totalCents)}</span>
            </div>
            {(data.extraTotals ?? []).map((r, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '3px 8px 0 0',
                  fontWeight: r.bold ? 700 : 400,
                  color: r.tone === 'success' ? '#168257' : r.tone === 'danger' ? '#C83737' : theme.primary,
                }}
              >
                <span>{S(r.label)}</span>
                <span>{S(r.value)}</span>
              </div>
            ))}
          </div>
        );
      }
      case 'payment':
        return data.paymentInstructions?.trim() ? (
          <div>
            <div style={label}>Payment instructions</div>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{S(data.paymentInstructions)}</div>
          </div>
        ) : null;
      case 'notes':
        return data.notes?.trim() ? (
          <div>
            <div style={label}>Notes</div>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{S(data.notes)}</div>
          </div>
        ) : null;
      case 'terms':
        return design.terms.trim() ? (
          <div>
            <div style={label}>Terms &amp; conditions</div>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.4, color: theme.muted, fontSize: base - 1 }}>{S(design.terms)}</div>
          </div>
        ) : null;
      case 'signature':
        return (
          <div style={{ display: 'flex', gap: 30, paddingTop: 24 }}>
            <div style={{ width: 230, borderTop: `0.7px solid ${theme.text}`, paddingTop: 4, ...mutedSmall }}>{S(design.signatureLabel)}</div>
            <div style={{ width: 130, borderTop: `0.7px solid ${theme.text}`, paddingTop: 4, ...mutedSmall }}>Date</div>
          </div>
        );
      default:
        return null;
    }
  };

  const footerSize = Math.max(7, base - 2);

  return (
    <div ref={wrapRef} className="w-full" data-testid="document-preview">
      <div style={{ height: sheetH * scale }} className="relative overflow-hidden rounded-xl border border-border bg-bg-tertiary">
        <div
          ref={sheetRef}
          style={{
            width: PW,
            minHeight: PH,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            background: '#FFFFFF',
            color: theme.text,
            fontFamily: FONT_STACK[theme.font],
            fontSize: base,
            lineHeight: 1.3,
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
          }}
          aria-label="Document preview"
        >
          {header.accentBar === 'top' && <div style={{ height: 6, background: theme.primary }} />}
          <div
            style={{
              background: band ? theme.primary : undefined,
              padding: band ? `28px ${M}px 22px` : `${header.accentBar === 'top' ? M - 6 : M}px 0 16px`,
              margin: band ? undefined : `0 ${M}px`,
              display: 'flex',
              justifyContent: 'space-between',
              flexDirection: brandRight ? 'row-reverse' : 'row',
              gap: 16,
              borderBottom: band ? undefined : '1px solid rgb(225,225,232)',
            }}
          >
            {brand}
            {title}
          </div>
          <div style={{ padding: `22px ${M}px 0`, display: 'flex', flexDirection: 'column', gap: 16, flex: 1 }}>
            {visibleSections(design, data.docType).map((id) => {
              const node = section(id);
              return node ? <div key={id}>{node}</div> : null;
            })}
          </div>
          <div
            style={{
              margin: `24px ${M}px ${M - 8}px`,
              paddingTop: 8,
              borderTop: '0.8px solid rgb(225,225,232)',
              display: 'flex',
              justifyContent: 'space-between',
              gap: 16,
              color: theme.muted,
              fontSize: footerSize,
            }}
          >
            <div style={{ maxWidth: '62%', whiteSpace: 'pre-wrap' }}>{S(design.footer.text)}</div>
            <div style={{ textAlign: 'right' }}>
              {design.footer.showPageNumbers && <div>Page 1 of 1</div>}
              {design.footer.showBranding && <div>Generated with Vireek</div>}
            </div>
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-text-secondary">
        Approximate preview. Page breaks and exact spacing are applied in the PDF — use “Download sample PDF” to check the real file.
      </p>
    </div>
  );
}
