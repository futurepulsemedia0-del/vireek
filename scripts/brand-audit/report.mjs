// scripts/brand-audit/report.mjs — self-contained HTML report. Every dynamic string is escaped (findings embed source
// snippets and page text, i.e. untrusted content). No external resources, so it opens offline and under strict CSP.
import { esc } from './lib/util.mjs';

const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toFixed(1).replace(/\.0$/, ''));
const tone = (s, target) => (s === null ? 'na' : s >= target ? 'good' : s >= 70 ? 'ok' : 'bad');
const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

export function renderReport({ scored, fixes, gate, crawlSummary, crawl, meta }) {
  const cmp = gate?.compare ?? { available: false, rows: [] };
  const delta = Object.fromEntries((cmp.rows ?? []).map((r) => [r.id, r.delta]));
  const catRows = scored.categories.map((c) => {
    const d = delta[c.id];
    return `<tr><td><a href="#cat-${esc(c.id)}">${esc(c.label)}</a></td><td class="n">${c.weight}</td>
      <td class="n"><span class="pill ${tone(c.score, c.target)}">${fmt(c.score)}</span></td><td class="n">${c.target}</td>
      <td class="n ${d < 0 ? 'bad' : d > 0 ? 'good' : ''}">${d === undefined ? '—' : (d > 0 ? '+' : '') + d}</td>
      <td>${c.status === 'not-run' ? '<b>NOT RUN</b>' : c.status === 'partial' ? `partial (${esc(c.notRunComponents.length)} component(s) not run)` : 'measured'}</td></tr>`;
  }).join('');
  const details = scored.categories.map((c) => `<details id="cat-${esc(c.id)}"><summary><b>${esc(c.label)}</b> — ${fmt(c.score)} / 100 <span class="muted">(target ${c.target}, weight ${c.weight})</span></summary>
    <table><thead><tr><th>Component</th><th class="n">Weight</th><th class="n">Score</th><th>Evidence</th></tr></thead><tbody>
    ${c.components.map((k) => `<tr><td>${esc(k.name)}</td><td class="n">${esc(k.weight)}</td><td class="n">${k.score === null || k.score === undefined ? '<b>NOT RUN</b>' : esc(fmt(k.score))}</td><td class="muted">${esc(k.detail ?? '')}</td></tr>`).join('') || '<tr><td colspan="4">No components ran for this category.</td></tr>'}
    </tbody></table></details>`).join('');
  const fixRows = fixes.map((f, i) => `<tr><td class="n">${i + 1}</td><td><span class="sev ${esc(f.severity)}">${esc(f.severity)}</span></td><td>${esc(f.category)}</td>
    <td><b>${esc(f.title)}</b>${f.detail ? `<div class="muted">${esc(f.detail).slice(0, 400)}</div>` : ''}
    <details><summary>${esc(Math.min(f.refs.length, 25))} reference(s)</summary><ul>${f.refs.slice(0, 25).map((r) => `<li><code>${esc([r.file, r.line, r.route].filter(Boolean).join(':'))}</code> ${esc(r.text ?? '')}</li>`).join('')}</ul></details></td>
    <td class="n">${esc(f.priority)}</td></tr>`).join('');
  const evidence = scored.categories.filter((c) => c.needsEvidence.length).map((c) => `<h3>${esc(c.label)}</h3><ul>${c.needsEvidence.map((e) => `<li>${esc(e.label)}${e.refs?.length ? `<details><summary>where</summary><ul>${e.refs.slice(0, 10).map((r) => `<li><code>${esc(r.file)}:${esc(r.line)}</code> ${esc(r.text)}</li>`).join('')}</ul></details>` : ''}</li>`).join('')}</ul>`).join('');
  const reg = cmp.available ? `<p>${cmp.regressions.length ? `<b class="bad">${cmp.regressions.length} regression(s)</b>` : '<b class="good">No regressions</b>'} vs the previous run.${cmp.regressions.map((r) => ` ${esc(r.label)} ${esc(r.delta)}.`).join('')}</p>` : '<p class="muted">No previous run to compare against yet.</p>';
  const gateHtml = gate ? `<p>${gate.pass ? '<b class="good">GATE PASSED</b>' : '<b class="bad">GATE FAILED</b>'}</p>${gate.failures.length ? `<ul>${gate.failures.map((f) => `<li class="bad">${esc(f)}</li>`).join('')}</ul>` : ''}${gate.warnings.length ? `<details><summary>${gate.warnings.length} warning(s)</summary><ul>${gate.warnings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></details>` : ''}` : '';
  const routes = (crawl?.routes ?? []);
  const routeRows = routes.map((r) => { const c = r.combos?.['light@1280'] ?? Object.values(r.combos ?? {})[0]; return `<tr><td><code>${esc(r.route)}</code></td><td>${esc(r.role)}</td><td>${r.skipped ? `<i>${esc(r.skipped)}</i>` : esc(r.status)}</td>
    <td class="n">${c?.axe ? esc(c.axe.total) : '—'}</td><td class="n">${c?.perf?.lcp != null ? esc(c.perf.lcp) : '—'}</td><td class="n">${c ? esc(c.layout?.overflow ? 'yes' : 'no') : '—'}</td><td class="n">${esc(r.console.length)}</td></tr>`; }).join('');
  const gallery = routes.filter((r) => r.shots?.length).map((r) => `<details><summary><code>${esc(r.route)}</code> — ${esc(r.shots.length)} screenshots</summary><div class="grid">${r.shots.map((s) => `<a href="${esc(encodeURI(s))}"><img loading="lazy" src="${esc(encodeURI(s))}" alt="${esc(`${r.route} ${s}`)}" width="180"><div class="muted">${esc(s.split('__').pop().replace('.jpg', ''))}</div></a>`).join('')}</div></details>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vireek brand audit — ${esc(fmt(scored.overall))}</title>
<style>:root{--bg:#fdfcfa;--fg:#17171a;--mut:#676770;--bd:#e7e5e0;--card:#fff;--good:#168458;--ok:#a05e12;--bad:#c83030;--acc:#203ad8}
@media(prefers-color-scheme:dark){:root{--bg:#090a0d;--fg:#f2f1ee;--mut:#9a9aa3;--bd:#24252c;--card:#101115;--good:#4ac78c;--ok:#ebaa46;--bad:#f06464;--acc:#6c82ff}}
body{font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px;max-width:1180px;margin-inline:auto}
h1,h2,h3{font-family:Sora,system-ui,sans-serif;letter-spacing:-.01em}a{color:var(--acc)}table{border-collapse:collapse;width:100%;background:var(--card);margin:8px 0 16px;font-size:14px}
th,td{border:1px solid var(--bd);padding:6px 10px;text-align:start;vertical-align:top}.n{text-align:end;white-space:nowrap}.muted{color:var(--mut);font-size:13px}.good{color:var(--good)}.bad{color:var(--bad)}
.pill{padding:2px 10px;border-radius:99px;font-weight:700;border:1px solid var(--bd)}.pill.good{color:var(--good)}.pill.ok{color:var(--ok)}.pill.bad{color:var(--bad)}.pill.na{color:var(--mut)}
.sev{font-weight:700;text-transform:uppercase;font-size:12px}.sev.critical,.sev.high{color:var(--bad)}.sev.medium{color:var(--ok)}.big{font-size:56px;font-weight:800;line-height:1}
.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:16px;margin:12px 0}.grid{display:flex;flex-wrap:wrap;gap:8px}.grid img{border:1px solid var(--bd);border-radius:6px;max-width:180px;height:auto}
details{margin:6px 0}summary{cursor:pointer}code{font-size:12px;word-break:break-all}</style></head><body>
<h1>Vireek brand audit</h1><p class="muted">Generated ${esc(meta.generatedAt)} · commit ${esc(meta.commit ?? 'unknown')} · mode ${esc(meta.mode)} · base ${esc(meta.baseUrl ?? 'n/a (static only)')}</p>
<div class="card"><div class="big">${esc(fmt(scored.overall))}<span class="muted" style="font-size:20px"> / 100</span></div>
<p><b>Rubric coverage: ${esc(fmt(scored.coverage))}%</b> of the weight was actually measured in this run. Unmeasured categories are shown as <b>NOT RUN</b> and are excluded — never counted as passing.</p>${gateHtml}${reg}</div>
<h2>Scores</h2><table><thead><tr><th>Category</th><th class="n">Weight</th><th class="n">Score</th><th class="n">Target</th><th class="n">Δ prev</th><th>Status</th></tr></thead><tbody>${catRows}</tbody></table>
${details}
<h2>Prioritized fix list</h2><p class="muted">priority = severity × category weight × (1 + log10(occurrences))</p><table><thead><tr><th>#</th><th>Sev</th><th>Category</th><th>Issue</th><th class="n">Priority</th></tr></thead><tbody>${fixRows || '<tr><td colspan="5">No findings.</td></tr>'}</tbody></table>
<h2>Needs real-world evidence <span class="muted">(not scored, not faked)</span></h2><p class="muted">These cannot be raised by code. They need third-party proof, real customers or real-world testing.</p>${evidence}
<h2>Crawl</h2><p class="muted">${esc(crawlSummary)}</p>${routes.length ? `<table><thead><tr><th>Route</th><th>Role</th><th>Status</th><th class="n">axe</th><th class="n">LCP ms</th><th class="n">Overflow</th><th class="n">Console errs</th></tr></thead><tbody>${routeRows}</tbody></table>` : '<p>No crawl in this run.</p>'}
<h2>Screenshots</h2>${gallery || '<p class="muted">No screenshots in this run.</p>'}</body></html>`;
}
