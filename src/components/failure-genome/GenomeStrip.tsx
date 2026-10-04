import { strandsOf, type GenomeDna } from '@/lib/failureGenome';

/** The 10-strand failure DNA of one unit. Blue tiles = profile you set; neutral tiles = learned from failures. */
export function GenomeStrip({ dna }: { dna: GenomeDna }) {
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {strandsOf(dna).map((s, i) => (
        <div
          key={s.key}
          className={`rounded-xl border px-3 py-2 ${s.kind === 'profile' ? 'border-accent/30 bg-accent/5' : 'border-border bg-bg-primary'}`}
        >
          <dt className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
            <span className="tabular-nums text-text-secondary/60">{String(i + 1).padStart(2, '0')}</span>
            {s.label}
          </dt>
          <dd
            className={`mt-0.5 truncate text-sm font-medium ${s.filled ? 'text-text-primary' : 'text-text-secondary/60'}`}
            title={s.value}
          >
            {s.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
