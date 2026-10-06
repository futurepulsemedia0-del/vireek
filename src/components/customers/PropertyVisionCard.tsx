import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ScanEye } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { PropertyVisionScanner } from '@/components/property-vision/PropertyVisionScanner';
import { CONDITION_STYLES, SEVERITY_STYLES, fetchAssets, remainingLabel, type PvAnalyzeResult, type PvAsset } from '@/lib/propertyVision';

/** Compact Property Vision memory for one customer — drop into CustomerDetailPage. */
export function PropertyVisionCard({ customerId }: { customerId: string }) {
  const [assets, setAssets] = useState<PvAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAssets(await fetchAssets({ customerId }));
    } catch {
      // Non-critical panel: fail quiet rather than break the customer page.
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => { void load(); }, [load]);

  const onDone = (r: PvAnalyzeResult) => {
    setScanning(false);
    setSummary(r.already_analyzed ? 'Those photos were already analyzed.' : `Recognized ${r.assets.length} unit${r.assets.length === 1 ? '' : 's'}${r.findings.new.length ? ` · ${r.findings.new.length} new finding${r.findings.new.length === 1 ? '' : 's'}` : ''}.`);
    void load();
  };

  if (loading) return null;
  const shown = assets.slice(0, 4);

  return (
    <div className="mb-6 rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent/10 text-accent"><ScanEye size={16} /></span>
          <h2 className="text-sm font-semibold text-text-primary">Property Vision</h2>
        </div>
        <div className="flex items-center gap-2">
          {!scanning && <Button variant="secondary" size="sm" onClick={() => setScanning(true)}>Scan photos</Button>}
          <Link to={`/dashboard/property-vision?customer=${customerId}`} className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:underline">
            Open <ArrowRight size={12} />
          </Link>
        </div>
      </div>

      {scanning && (
        <div className="mb-3">
          <PropertyVisionScanner scope={{ customerId }} onDone={onDone} onCancel={() => setScanning(false)} />
        </div>
      )}
      {summary && <p role="status" className="mb-3 text-xs font-medium text-accent">{summary}</p>}

      {assets.length === 0 ? (
        <p className="text-xs text-text-secondary">
          Photograph equipment to build this home&apos;s lasting memory — model, serial, condition, hazards and age, remembered for every future visit.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {shown.map((a) => (
            <li key={a.id}>
              <Link to={`/dashboard/property-vision?customer=${customerId}&asset=${a.id}`} className="focus-ring flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-xs hover:bg-bg-tertiary">
                <span className="flex min-w-0 items-center gap-2 text-text-primary">
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${CONDITION_STYLES[a.condition]}`}>{a.condition}</span>
                  <span className="truncate">{a.label}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-text-secondary">
                  {a.open_hazard_count > 0 && a.max_open_severity && (
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${SEVERITY_STYLES[a.max_open_severity]}`}>{a.open_hazard_count} hazard{a.open_hazard_count === 1 ? '' : 's'}</span>
                  )}
                  <span className="hidden sm:inline">{remainingLabel(a)}</span>
                </span>
              </Link>
            </li>
          ))}
          {assets.length > shown.length && <li className="px-2 text-[11px] text-text-secondary">+ {assets.length - shown.length} more</li>}
        </ul>
      )}
    </div>
  );
}
