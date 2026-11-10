// Harness entry: the REAL chart components inside a container of a given CSS width (?w=360).
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { CallVolumeChart } from '@/components/overview/CallVolumeChart';
import { UsageCostChart } from '@/components/staff/UsageCostChart';
import { SurveyTrendChart } from '@/components/surveys/SurveyTrendChart';
import { ReportChart } from '@/components/reports/ReportChart';

const w = Number(new URLSearchParams(location.search).get('w') ?? 720);
const day = (i: number) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10);
const N = 14;

createRoot(document.getElementById('root')!).render(
  <div style={{ width: w, display: 'flex', flexDirection: 'column', gap: 24, padding: 12 }}>
    <section data-case="call-volume"><CallVolumeChart title="Calls" data={Array.from({ length: N }, (_, i) => ({ date: day(i), count: 4 + ((i * 7) % 11) }))} events={[{ date: day(5), label: 'Storm' }]} /></section>
    <section data-case="usage-cost"><UsageCostChart points={Array.from({ length: N }, (_, i) => ({ day: day(i), aiCostUsd: 1 + i * 0.2, voiceCostUsd: 2 + (i % 4), totalUsd: 3 + i * 0.2 + (i % 4) }))} /></section>
    <section data-case="survey-trend"><SurveyTrendChart type="nps" points={Array.from({ length: N }, (_, i) => ({ date: day(i), responses: 3 + (i % 5), value: 20 + ((i * 9) % 50) }))} /></section>
    <section data-case="report-line"><ReportChart type="line" title="Revenue" formatValue={(v) => `$${v}`} groups={Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, label: `Week ${i + 1}`, sortKey: String(i), count: 3 + i, value: 100 + i * 37 }))} /></section>
  </div>,
);
