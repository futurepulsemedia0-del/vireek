# @vireek/cli

Command-line access to the Vireek API: browse data, export it, and test webhooks locally.
Zero runtime dependencies. Requires Node.js ≥ 20.3.

## Install (from this repo)

```bash
npm run cli:build            # from the repo root
node packages/cli/bin/vireek.js help
# optional: make `vireek` available globally
npm link --prefix packages/cli
```

## Authenticate

Create a key under **Dashboard → API Keys** (scopes `calls:read`, `leads:read`, `jobs:read`), then:

```bash
vireek auth login          # prompts for base URL + key (hidden)
vireek auth status --verify
```

Base URL: `https://<project-ref>.supabase.co/functions/v1/api-v1`.

For CI, use environment variables instead of a config file:

```bash
export VIREEK_API_URL=https://<project-ref>.supabase.co/functions/v1/api-v1
export VIREEK_API_KEY=vrk_live_…
```

Precedence: flags → environment → saved profile. Credentials are stored in
`~/.config/vireek/config.json` (`%APPDATA%\vireek\config.json` on Windows) with owner-only permissions.

## Read data

```bash
vireek calls list --limit 10
vireek jobs get <id>
vireek leads list --json | jq '.data[].name'
vireek api calls --param limit=5
```

## Export

```bash
vireek export calls --since 30d -o calls.csv          # format inferred from extension
vireek export jobs --since 2026-10-01 --until 2026-11-01 -o jobs.json
vireek export leads --format ndjson | jq -c .          # stream to stdout
```

- Rows are fetched newest-first, 100 per request, with automatic retry/backoff on `429` and `5xx`.
- Files are written to `<name>.partial` and renamed on success; an interrupted export never leaves a truncated file.
- CSV cells that begin with `= + - @` are prefixed with `'` to prevent spreadsheet formula injection (`--no-csv-guard` to disable).
- Add `--bom` if Excel mis-detects UTF-8.

## Webhook testing

Endpoints are signed with HMAC-SHA256 over the **raw body** (`X-Vireek-Signature`, hex), with the delivery id in `X-Vireek-Delivery-Id`.

```bash
export VIREEK_WEBHOOK_SECRET=whsec_…
vireek webhooks listen --port 4242                      # local receiver, verifies every delivery
vireek webhooks trigger job.completed --url http://localhost:4242/hook
vireek webhooks trigger custom.event --url https://example.com/hook --data payload.json
vireek webhooks sign --body-file body.json              # produce a signature
vireek webhooks verify --body-file body.json --signature <hex>
vireek webhooks events
```

Sample records for built-in events are illustrative; use `--data` to send the exact record your receiver handles.
`trigger` makes a single attempt with a 10 s timeout, like production.

## Exit codes

`0` ok · `1` error · `2` usage · `3` authentication/permission · `130` interrupted

## Development

```bash
npm run cli:typecheck
npm test -- packages/cli
```

Set `VIREEK_DEBUG=1` for stack traces and error causes.
