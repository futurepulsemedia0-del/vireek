# @vireek/sdk (Beta)

Typed client for the Vireek API. The code in `src/index.ts` is **generated** from the API contract
(`node scripts/gen-sdk.mjs generate`) and checked in CI, so it cannot drift from the API.

```ts
import { Vireek, VireekError } from '@vireek/sdk';

const vireek = new Vireek({
  apiKey: process.env.VIREEK_API_KEY!,        // vrk_test_… for synthetic data
  baseUrl: process.env.VIREEK_BASE_URL!,      // https://<project-ref>.supabase.co/functions/v1/api-v1
});

const page = await vireek.calls.list({ limit: 10 });
for await (const lead of vireek.leads.iterate()) console.log(lead.name);

try {
  await vireek.jobs.get('00000000-0000-4300-8000-000000000000');
} catch (e) {
  if (e instanceof VireekError && e.code === 'record_not_found') { /* … */ }
}
```

429 and 5xx responses are retried (default 2 times, honouring `Retry-After`). Not published to npm yet.
