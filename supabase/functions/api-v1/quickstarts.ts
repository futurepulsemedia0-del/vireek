// supabase/functions/api-v1/quickstarts.ts
//
// "First API call in 5 minutes" guides. Pure data, no imports (Deno, Vite and Node >= 22.18 all load it).
// Every `code` is EXECUTED in CI against a contract-derived mock server (scripts/run-samples.mjs) and must
// print a line starting with "OK:" — a quickstart that does not run cannot ship.

export interface QuickstartStep {
  title: string;
  body: string;
}

export interface Quickstart {
  id: string;
  title: string;
  useCase: string;
  /** Honest estimate for someone with Node/Python installed; the page also shows the measured time for the signed-in user. */
  estimateMinutes: number;
  language: 'javascript' | 'python';
  filename: string;
  steps: QuickstartStep[];
  code: string;
}

const ENV_STEP: QuickstartStep = {
  title: 'Create a test key and set two environment variables',
  body: 'In Settings → API Keys create a key in Test mode with the scope shown below. Then run: export VIREEK_API_KEY=vrk_test_… and export VIREEK_BASE_URL=https://<project-ref>.supabase.co/functions/v1/api-v1. Test keys return synthetic data, so nothing real is touched.',
};

export const QUICKSTARTS: Quickstart[] = [
  {
    id: 'sync-calls',
    title: 'Sync new calls into your CRM',
    useCase: 'Pull the latest calls with their summaries so your CRM or spreadsheet is always current.',
    estimateMinutes: 5,
    language: 'javascript',
    filename: 'sync-calls.mjs',
    steps: [
      ENV_STEP,
      { title: 'Give the key the calls:read scope', body: 'Tick “Read calls” when creating the key. Other scopes are not needed for this guide.' },
      { title: 'Save the script and run it', body: 'Save sync-calls.mjs and run: node sync-calls.mjs (Node 18 or newer). It prints one line per call and finishes with a line starting with OK.' },
      { title: 'Go live', body: 'Create a Live key, set it in VIREEK_API_KEY and run the same script against your real calls. Store the newest created_at you processed and pass it back next time to avoid reprocessing.' },
    ],
    code: `const base = process.env.VIREEK_BASE_URL;
const key = process.env.VIREEK_API_KEY;
if (!base || !key) throw new Error("Set VIREEK_BASE_URL and VIREEK_API_KEY first");

const res = await fetch(\`\${base}/calls?limit=10\`, { headers: { Authorization: \`Bearer \${key}\` } });
if (!res.ok) throw new Error(\`\${res.status}: \${await res.text()}\`);
const { data, has_more } = await res.json();

for (const call of data) {
  console.log(\`\${call.created_at}  \${call.caller_name ?? "Unknown caller"}  \${call.summary ?? ""}\`);
}
console.log(\`OK: fetched \${data.length} calls (more available: \${has_more})\`);`,
  },
  {
    id: 'new-lead-alert',
    title: 'Alert your team about new leads',
    useCase: 'Find leads still in the "new" stage so you can message them or create a task.',
    estimateMinutes: 5,
    language: 'javascript',
    filename: 'new-leads.mjs',
    steps: [
      ENV_STEP,
      { title: 'Give the key the leads:read scope', body: 'Tick “Read leads” when creating the key.' },
      { title: 'Run the script', body: 'Save new-leads.mjs and run: node new-leads.mjs. Replace the console.log with your Slack, email or task call.' },
      { title: 'Prefer pushes over polling', body: 'To be notified the moment a lead is captured, subscribe to the lead.created webhook instead (see Webhooks in the docs) and verify its signature.' },
    ],
    code: `const base = process.env.VIREEK_BASE_URL;
const key = process.env.VIREEK_API_KEY;
if (!base || !key) throw new Error("Set VIREEK_BASE_URL and VIREEK_API_KEY first");

const res = await fetch(\`\${base}/leads?limit=100\`, { headers: { Authorization: \`Bearer \${key}\` } });
if (!res.ok) throw new Error(\`\${res.status}: \${await res.text()}\`);
const { data } = await res.json();

const fresh = data.filter((lead) => lead.stage === "new");
for (const lead of fresh) console.log(\`New lead: \${lead.name} \${lead.phone ?? ""} — \${lead.service_interested ?? "no service given"}\`);
console.log(\`OK: \${fresh.length} new leads out of \${data.length}\`);`,
  },
  {
    id: 'export-jobs-csv',
    title: 'Export scheduled jobs to a CSV',
    useCase: 'Download every job to a CSV for reporting or dispatch tools.',
    estimateMinutes: 6,
    language: 'python',
    filename: 'export_jobs.py',
    steps: [
      ENV_STEP,
      { title: 'Install requests and grant jobs:read', body: 'Run: pip install requests. Tick “Read jobs” when creating the key.' },
      { title: 'Run the script', body: 'Save export_jobs.py and run: python export_jobs.py. It follows next_before through every page and writes jobs.csv.' },
      { title: 'Respect the rate limit', body: 'The API allows 120 requests per minute per key. If you ever get a 429, wait for the Retry-After header and try again.' },
    ],
    code: `import csv
import os

import requests

base = os.environ["VIREEK_BASE_URL"]
headers = {"Authorization": f"Bearer {os.environ['VIREEK_API_KEY']}"}

rows, before = [], None
while True:
    params = {"limit": 100}
    if before:
        params["before"] = before
    res = requests.get(f"{base}/jobs", params=params, headers=headers, timeout=30)
    res.raise_for_status()
    page = res.json()
    rows.extend(page["data"])
    before = page["next_before"]
    if len(page["data"]) < 100 or not before:
        break

fields = ["id", "customer_name", "service_type", "scheduled_datetime", "job_status", "invoice_amount"]
with open("jobs.csv", "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
print(f"OK: wrote {len(rows)} jobs to jobs.csv")`,
  },
];
