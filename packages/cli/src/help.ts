export const HELP: Record<string, string> = {
  main: `Vireek CLI — API access, data exports and webhook testing.

Usage:
  vireek <command> [options]

Commands:
  auth        login | status | logout          Manage credentials
  calls       list | get <id>                  Read calls
  leads       list | get <id>                  Read leads
  jobs        list | get <id>                  Read jobs
  api         <path> [--param k=v]             Raw authenticated GET
  export      <calls|leads|jobs> [options]     Export to CSV / JSON / NDJSON
  webhooks    events | trigger | listen | verify | sign

Global options:
  --profile <name>     Saved profile to use (env: VIREEK_PROFILE)
  --base-url <url>     API base URL            (env: VIREEK_API_URL)
  --api-key <key>      API key — prefer VIREEK_API_KEY; flags land in shell history
  --json               Machine-readable output
  -q, --quiet          Suppress progress and informational messages
  -h, --help           Show help
  -v, --version        Show version

Run "vireek help <command>" for details.
Exit codes: 0 ok · 1 error · 2 usage · 3 auth/permission · 130 interrupted`,

  auth: `Usage:
  vireek auth login  [--profile <name>] [--base-url <url>] [--with-key] [--no-verify] [--default]
  vireek auth status [--profile <name>] [--verify]
  vireek auth logout [--profile <name>]

login prompts for the base URL and key (input hidden). For CI use
VIREEK_API_KEY / VIREEK_API_URL instead, or pipe the key: echo "$KEY" | vireek auth login --with-key --base-url <url>.
Credentials are stored in ~/.config/vireek/config.json (owner-only permissions).`,

  resource: `Usage:
  vireek <calls|leads|jobs> list [--limit 1-100] [--before <iso>] [--columns a,b] [--json]
  vireek <calls|leads|jobs> get <id>

On a terminal, list prints a table; when piped (or with --json) it prints the raw API response.`,

  api: `Usage:
  vireek api <path> [--param key=value ...]

Example: vireek api calls --param limit=5
Only GET is supported; the API is read-only today.`,

  export: `Usage:
  vireek export <calls|leads|jobs> [options]

Options:
  -f, --format <csv|json|ndjson>   Default: from the --out extension, else ndjson
  -o, --out <file>                 Write to a file (atomic; default: stdout)
      --force                      Overwrite an existing file
      --since <when>               Only rows created at/after this (2026-10-01, 7d, 24h)
      --until <when>               Only rows created before this
      --max <n>                    Stop after n rows
      --page-size <1-100>          Rows per request (default 100)
      --no-csv-guard               Do not prefix formula-like cells ( = + - @ ) with '
      --bom                        CSV: add a UTF-8 BOM so Excel detects the encoding

Rows are fetched newest first. Nested values (arrays/objects) are written as JSON.`,

  webhooks: `Usage:
  vireek webhooks events
  vireek webhooks trigger <event> --url <url> [--secret <whsec>] [--data <file|->] [--allow-insecure]
  vireek webhooks listen  [--port 4242] [--host 127.0.0.1] [--secret <whsec>] [--show-body]
  vireek webhooks verify  --signature <hex> (--body-file <file|-> | --body <text>) [--secret <whsec>]
  vireek webhooks sign    (--body-file <file|-> | --body <text>) [--secret <whsec>]

The secret is your endpoint's signing secret (whsec_…); prefer VIREEK_WEBHOOK_SECRET over --secret.
Deliveries are signed exactly like production: HMAC-SHA256 hex over the raw body, sent in
X-Vireek-Signature, with the delivery id in X-Vireek-Delivery-Id.`,
};
