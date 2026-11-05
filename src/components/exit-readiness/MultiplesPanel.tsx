import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useExitT } from '@/i18n/exitReadyNamespace';
import { INDUSTRY_PRESETS, type IndustryKey } from '@/lib/exitReadiness';
import {
  SIZE_BANDS, SIZE_BAND_LABELS, validateMultipleRow,
  type EffectiveMultiples, type MultipleProvenance, type MultipleRow, type SizeBand,
} from '@/lib/exitLineage';
import { EstimateBanner, Toggle, selectClass } from './shared';

interface Props {
  unavailable: boolean;
  rows: MultipleRow[];
  effective: EffectiveMultiples;
  industryKey: IndustryKey;
  saving: boolean;
  onSave: (row: MultipleRow) => Promise<void>;
  onDelete: (row: MultipleRow) => Promise<void>;
}

const INDUSTRIES = Object.keys(INDUSTRY_PRESETS) as IndustryKey[];

/** Where the multiple used in the estimate came from. Reused on the Estimate tab. */
export function MultipleProvenanceNote({ effective, basis }: { effective: EffectiveMultiples; basis: 'sde' | 'ebitda' }) {
  const { t } = useExitT();
  const p: MultipleProvenance = effective[basis];
  return (
    <p className="text-xs text-text-secondary">
      <span className="font-medium text-text-primary">{basis === 'sde' ? t('multiples.basisSde') : t('multiples.basisEbitda')}: </span>
      {t(`multiples.origin_${p.origin}`)}
      {p.origin === 'table' && <> — {p.source}{p.sourceDate ? `, ${t('multiples.published', { date: p.sourceDate })}` : ''}</>}
      {p.illustrative && <span className="ms-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">{t('multiples.illustrative')}</span>}
    </p>
  );
}

export function MultiplesPanel({ unavailable, rows, effective, industryKey, saving, onSave, onDelete }: Props) {
  const { t } = useExitT();
  const [industry, setIndustry] = useState<IndustryKey>(industryKey);
  const [band, setBand] = useState<SizeBand>(effective.sizeBand ?? '1m_to_5m');
  const [basis, setBasis] = useState<'sde' | 'ebitda'>('sde');
  const [low, setLow] = useState('');
  const [mid, setMid] = useState('');
  const [high, setHigh] = useState('');
  const [source, setSource] = useState('');
  const [sourceDate, setSourceDate] = useState('');
  const [illustrative, setIllustrative] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (unavailable) return <p className="rounded-xl bg-bg-tertiary px-3 py-3 text-sm text-text-secondary">{t('common.unavailable')}</p>;

  const submit = async () => {
    const found = validateMultipleRow({ low, mid, high, source, sourceDate });
    setErrors(found);
    if (Object.keys(found).length) return;
    await onSave({ industryKey: industry, sizeBand: band, basis, low: Number(low), mid: Number(mid), high: Number(high), source: source.trim(), sourceDate, isIllustrative: illustrative });
    setLow(''); setMid(''); setHigh(''); setSource(''); setSourceDate('');
  };

  return (
    <div className="space-y-6">
      <EstimateBanner compact />
      <Card>
        <h2 className="text-lg font-semibold text-text-primary">{t('multiples.title')}</h2>
        <p className="mt-1 text-sm text-text-secondary">{t('multiples.intro')}</p>
        <h3 className="mb-1 mt-4 text-sm font-semibold text-text-primary">{t('multiples.usedNow')}</h3>
        <p className="mb-2 text-xs text-text-secondary">{effective.sizeBand ? t('multiples.sizeBand', { band: SIZE_BAND_LABELS[effective.sizeBand] }) : t('multiples.noBand')}</p>
        <div className="space-y-1">
          <MultipleProvenanceNote effective={effective} basis="sde" />
          <MultipleProvenanceNote effective={effective} basis="ebitda" />
        </div>
      </Card>

      <Card>
        <h3 className="mb-3 text-sm font-semibold text-text-primary">{t('multiples.tableTitle')}</h3>
        {rows.length === 0 ? <p className="mb-4 text-xs text-text-secondary">{t('multiples.empty')}</p> : (
          <div className="mb-4 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('multiples.tableTitle')}</caption>
              <thead>
                <tr className="border-b border-border text-xs text-text-secondary">
                  {(['industry', 'band', 'basis', 'low', 'mid', 'high', 'source'] as const).map((k) => <th key={k} scope="col" className="py-2 pe-3 text-start font-medium">{t(`multiples.${k}`)}</th>)}
                  <th scope="col" className="py-2 text-start font-medium"><span className="sr-only">{t('multiples.delete')}</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.industryKey}-${r.sizeBand}-${r.basis}`} className="border-b border-border/60">
                    <td className="py-2 pe-3">{INDUSTRY_PRESETS[r.industryKey].label}</td>
                    <td className="py-2 pe-3">{SIZE_BAND_LABELS[r.sizeBand]}</td>
                    <td className="py-2 pe-3">{r.basis === 'sde' ? t('multiples.basisSde') : t('multiples.basisEbitda')}</td>
                    <td className="py-2 pe-3">{r.low}×</td><td className="py-2 pe-3">{r.mid}×</td><td className="py-2 pe-3">{r.high}×</td>
                    <td className="py-2 pe-3 text-xs text-text-secondary">
                      {r.source} · {t('multiples.published', { date: r.sourceDate })}
                      {r.isIllustrative && <span className="ms-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">{t('multiples.illustrative')}</span>}
                    </td>
                    <td className="py-2">
                      <Button size="sm" variant="ghost" disabled={saving} aria-label={t('multiples.deleteLabel', { industry: INDUSTRY_PRESETS[r.industryKey].label, band: SIZE_BAND_LABELS[r.sizeBand], basis: r.basis === 'sde' ? t('multiples.basisSde') : t('multiples.basisEbitda') })} onClick={() => void onDelete(r)}>{t('multiples.delete')}</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="mt-industry" className="mb-1.5 block text-sm font-medium text-text-primary">{t('multiples.industry')}</label>
            <select id="mt-industry" className={selectClass} value={industry} onChange={(e) => setIndustry(e.target.value as IndustryKey)}>
              {INDUSTRIES.map((k) => <option key={k} value={k}>{INDUSTRY_PRESETS[k].label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="mt-band" className="mb-1.5 block text-sm font-medium text-text-primary">{t('multiples.band')}</label>
            <select id="mt-band" className={selectClass} value={band} onChange={(e) => setBand(e.target.value as SizeBand)}>
              {SIZE_BANDS.map((b) => <option key={b} value={b}>{SIZE_BAND_LABELS[b]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="mt-basis" className="mb-1.5 block text-sm font-medium text-text-primary">{t('multiples.basis')}</label>
            <select id="mt-basis" className={selectClass} value={basis} onChange={(e) => setBasis(e.target.value as 'sde' | 'ebitda')}>
              <option value="sde">{t('multiples.basisSde')}</option>
              <option value="ebitda">{t('multiples.basisEbitda')}</option>
            </select>
          </div>
          <Input id="mt-low" label={t('multiples.low')} type="number" inputMode="decimal" step="0.1" min="0" value={low} onChange={(e) => setLow(e.target.value)} error={errors.range} />
          <Input id="mt-mid" label={t('multiples.mid')} type="number" inputMode="decimal" step="0.1" min="0" value={mid} onChange={(e) => setMid(e.target.value)} />
          <Input id="mt-high" label={t('multiples.high')} type="number" inputMode="decimal" step="0.1" min="0" value={high} onChange={(e) => setHigh(e.target.value)} />
          <div className="sm:col-span-2"><Input id="mt-source" label={t('multiples.source')} value={source} onChange={(e) => setSource(e.target.value)} error={errors.source} helperText={t('multiples.sourceHelp')} maxLength={300} /></div>
          <Input id="mt-date" label={t('multiples.sourceDate')} type="date" value={sourceDate} onChange={(e) => setSourceDate(e.target.value)} error={errors.sourceDate} />
        </div>
        <div className="mt-4"><Toggle id="mt-illustrative" checked={illustrative} onChange={setIllustrative} label={t('multiples.markIllustrative')} hint={t('multiples.markIllustrativeHint')} /></div>
        <div className="mt-4"><Button onClick={() => void submit()} disabled={saving} aria-busy={saving}>{saving ? t('multiples.saving') : t('multiples.addRow')}</Button></div>
      </Card>
    </div>
  );
}
