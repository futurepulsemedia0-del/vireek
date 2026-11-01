import { NAMING_RULES } from '@/lib/brand/brandConfig';

export function NamingRules() {
  return (
    <section id="naming" className="scroll-mt-24 px-6 py-20 sm:py-24">
      <div className="mx-auto max-w-4xl">
        <p className="text-center text-eyebrow font-semibold uppercase text-text-secondary">Naming</p>
        <h2 className="mt-3 text-center font-display text-3xl font-bold text-text-primary">How we write Vireek</h2>
        <div className="mt-10 overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
          <table className="w-full text-left text-sm">
            <thead className="text-text-secondary">
              <tr>
                <th scope="col" className="px-4 py-3">Rule</th>
                <th scope="col" className="px-4 py-3">Do</th>
                <th scope="col" className="px-4 py-3">Don’t</th>
              </tr>
            </thead>
            <tbody>
              {NAMING_RULES.map((r) => (
                <tr key={r.rule} className="border-t border-border align-top">
                  <th scope="row" className="px-4 py-3 font-semibold text-text-primary">{r.rule}</th>
                  <td className="px-4 py-3 text-text-primary">{r.do}</td>
                  <td className="px-4 py-3 text-text-secondary">{r.dont}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
