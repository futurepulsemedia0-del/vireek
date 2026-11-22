#!/usr/bin/env node
// Records REAL Jobber responses from a developer TEST account into supabase/functions/_shared/price-book/__fixtures__/
// (read-only queries only) with ids/emails/phones/names redacted. Review the diff before committing.
// Usage: JOBBER_SANDBOX_TOKEN=<test-account token> node scripts/jobber/record-fixtures.mjs --i-am-on-a-test-account
// STATUS: NOT RUN (no Jobber test account available when written). [VERIFY] queries against current GraphiQL.
import { writeFileSync } from 'node:fs'

const TOKEN = process.env.JOBBER_SANDBOX_TOKEN
if (!TOKEN || !process.argv.includes('--i-am-on-a-test-account')) {
  console.error('Refusing to run: set JOBBER_SANDBOX_TOKEN (test account) and pass --i-am-on-a-test-account.')
  process.exit(2)
}
const URL_ = 'https://api.getjobber.com/api/graphql'
const VERSION = '2025-04-16'
const OUT = new URL('../../supabase/functions/_shared/price-book/__fixtures__/', import.meta.url)

const REDACT_KEYS = /^(email|emails|phone|phones|number|firstName|lastName|name|companyName|address|street1|street2|city|postalCode)$/i
const redact = (v) => {
  if (Array.isArray(v)) return v.map(redact)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, REDACT_KEYS.test(k) && typeof x === 'string' ? 'REDACTED' : redact(x)]))
  return v
}
async function record(file, query) {
  const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-JOBBER-GRAPHQL-VERSION': VERSION }, body: JSON.stringify({ query }) })
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`)
  writeFileSync(new URL(file, OUT), JSON.stringify(redact(await res.json()), null, 2) + '\n')
  console.log('recorded', file)
}
await record('jobber-account.recorded.json', '{ account { id } }')
await record('jobber-products.recorded.json', '{ products(first: 5) { nodes { id name category defaultUnitCost } pageInfo { hasNextPage endCursor } } }')
await record('jobber-client-search-empty.recorded.json', '{ clients(searchTerm: "vireek-fixture-no-such-client", first: 1) { nodes { id } } }')
