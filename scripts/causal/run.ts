/** CLI:  npx vite-node scripts/causal/run.ts [seeds]   — prints the study as JSON (every number is computed, none typed in). */
import { runStudy } from './study';

const seeds = Number(process.argv[2] ?? 200);
const out = {
  main: runStudy({ jobs: 6000 }, seeds),
  smallN: runStudy({ jobs: 600 }, seeds),
};
console.log(JSON.stringify(out, null, 2));
