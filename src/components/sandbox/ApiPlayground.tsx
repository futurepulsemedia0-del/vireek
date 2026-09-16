import { useCallback, useMemo, useState } from 'react';
import {
  Play,
  Copy,
  Check,
  KeyRound,
  Loader2,
  Terminal,
  Clock,
  AlertCircle,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import {
  SANDBOX_ENDPOINTS,
  SandboxEndpoint,
  executeSandboxRequest,
  buildCurl,
  loadStoredKey,
  saveStoredKey,
  PlaygroundResult,
  API_BASE,
} from '@/lib/sandbox';

function StatusBadge({ result }: { result: PlaygroundResult | null }) {
  if (!result) return null;
  const color = result.ok
    ? 'bg-success-500/10 text-success-500'
    : result.status === 0
      ? 'bg-warning-500/10 text-warning-500'
      : 'bg-danger-500/10 text-danger-500';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${color}`}>
      {result.status || '—'} {result.statusText}
    </span>
  );
}

export function ApiPlayground() {
  const [endpointId, setEndpointId] = useState(SANDBOX_ENDPOINTS[0].id);
  const [apiKey, setApiKey] = useState(() => loadStoredKey());
  const [resourceId, setResourceId] = useState('');
  const [limit, setLimit] = useState(5);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [copied, setCopied] = useState<'key' | 'curl' | 'body' | null>(null);

  const endpoint = useMemo(
    () => SANDBOX_ENDPOINTS.find((e) => e.id === endpointId) as SandboxEndpoint,
    [endpointId],
  );

  const resolvedPath = useMemo(() => {
    if (endpoint.hasId) {
      return endpoint.path.replace(':id', resourceId.trim() || ':id');
    }
    return endpoint.path;
  }, [endpoint, resourceId]);

  const fullUrl = useMemo(() => {
    const u = new URL(API_BASE + resolvedPath);
    if (!endpoint.hasId) u.searchParams.set('limit', String(limit));
    return u.toString();
  }, [resolvedPath, endpoint.hasId, limit]);

  const curl = useMemo(
    () => buildCurl({ method: endpoint.method, url: fullUrl, apiKey }),
    [endpoint.method, fullUrl, apiKey],
  );

  const onKeyChange = (v: string) => {
    setApiKey(v);
    saveStoredKey(v);
  };

  const run = useCallback(async () => {
    if (!apiKey.trim()) {
      setResult({
        ok: false,
        status: 0,
        statusText: 'Missing key',
        latencyMs: 0,
        body: null,
        raw: '',
        error: 'Paste a valid API key (vrk_live_…) first. Create one under Settings → API Keys.',
      });
      return;
    }
    if (endpoint.hasId && !resourceId.trim()) {
      setResult({
        ok: false,
        status: 0,
        statusText: 'Missing ID',
        latencyMs: 0,
        body: null,
        raw: '',
        error: 'Provide a resource ID for this endpoint.',
      });
      return;
    }
    setLoading(true);
    setResult(null);
    const path = endpoint.hasId
      ? endpoint.path.replace(':id', resourceId.trim())
      : endpoint.path;
    const res = await executeSandboxRequest({
      method: endpoint.method,
      path,
      apiKey,
      limit: endpoint.hasId ? undefined : limit,
    });
    setResult(res);
    setLoading(false);
  }, [apiKey, endpoint, resourceId, limit]);

  const copy = async (what: 'key' | 'curl' | 'body', text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(null), 1800);
  };

  return (
    <Card className="overflow-hidden border-border bg-bg-secondary/80 p-0">
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Terminal size={18} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">API Playground</h3>
          <p className="text-xs text-text-secondary">
            Live requests against <code className="font-mono text-[11px]">api-v1</code> — your real data, real scopes.
          </p>
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-2">
        {/* Request builder */}
        <div className="space-y-4 border-b border-border p-5 lg:border-b-0 lg:border-r">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">Endpoint</label>
            <div className="relative">
              <select
                value={endpointId}
                onChange={(e) => {
                  setEndpointId(e.target.value);
                  setResult(null);
                }}
                className="w-full appearance-none rounded-xl border border-border bg-bg-primary px-3 py-2.5 pr-9 text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              >
                {SANDBOX_ENDPOINTS.map((ep) => (
                  <option key={ep.id} value={ep.id}>
                    {ep.method} {ep.path} — {ep.description}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary" />
            </div>
            <p className="mt-1.5 text-[11px] text-text-secondary">
              Required scope: <code className="font-mono text-accent">{endpoint.scope}</code>
            </p>
          </div>

          {endpoint.hasId && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-secondary">Resource ID</label>
              <input
                value={resourceId}
                onChange={(e) => setResourceId(e.target.value)}
                placeholder="uuid of the call / lead / job"
                className="w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 font-mono text-sm text-text-primary placeholder:text-text-secondary/60 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
            </div>
          )}

          {!endpoint.hasId && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-secondary">Limit (1–100)</label>
              <input
                type="number"
                min={1}
                max={100}
                value={limit}
                onChange={(e) => setLimit(Math.min(100, Math.max(1, Number(e.target.value) || 5)))}
                className="w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
            </div>
          )}

          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
              <KeyRound size={12} /> API Key
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => onKeyChange(e.target.value)}
                placeholder="vrk_live_…"
                className="w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 font-mono text-sm text-text-primary placeholder:text-text-secondary/60 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="shrink-0"
                onClick={() => copy('key', apiKey)}
                disabled={!apiKey}
              >
                {copied === 'key' ? <Check size={14} /> : <Copy size={14} />}
              </Button>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-text-secondary">
              Key is stored only in this browser (localStorage). Create or rotate keys in{' '}
              <a href="/dashboard/api-keys" className="text-accent hover:underline">
                Settings → API Keys
              </a>
              .
            </p>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="primary" size="md" onClick={run} disabled={loading}>
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
              {loading ? 'Sending…' : 'Send request'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="md"
              onClick={() => copy('curl', curl)}
            >
              {copied === 'curl' ? <Check size={14} /> : <Copy size={14} />}
              Copy cURL
            </Button>
          </div>
        </div>

        {/* Response */}
        <div className="flex flex-col p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-text-secondary">Response</span>
            <div className="flex items-center gap-2">
              {result && (
                <>
                  <StatusBadge result={result} />
                  <span className="inline-flex items-center gap-1 text-[11px] text-text-secondary">
                    <Clock size={11} />
                    {result.latencyMs} ms
                  </span>
                </>
              )}
            </div>
          </div>

          {!result && !loading && (
            <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-bg-primary/50 px-4 py-12 text-center">
              <Terminal size={22} className="mb-2 text-text-secondary/70" />
              <p className="text-sm text-text-secondary">
                Choose an endpoint, paste your key, then hit Send.
              </p>
            </div>
          )}

          {loading && (
            <div className="flex flex-1 items-center justify-center rounded-xl border border-border bg-bg-primary/50 py-16">
              <Loader2 size={22} className="animate-spin text-accent" />
            </div>
          )}

          {result && !loading && (
            <div className="relative flex-1">
              {result.error && (
                <div className="mb-3 flex items-start gap-2 rounded-xl border border-danger-500/30 bg-danger-500/5 px-3 py-2.5 text-sm text-danger-500">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" />
                  <span>{result.error}</span>
                </div>
              )}
              <pre className="max-h-[420px] overflow-auto rounded-xl border border-border bg-bg-primary p-4 font-mono text-[12px] leading-relaxed text-text-primary">
                {typeof result.body === 'string'
                  ? result.body || '(empty)'
                  : JSON.stringify(result.body, null, 2)}
              </pre>
              <button
                type="button"
                onClick={() =>
                  copy(
                    'body',
                    typeof result.body === 'string'
                      ? result.body
                      : JSON.stringify(result.body, null, 2),
                  )
                }
                className="absolute right-3 top-3 rounded-lg border border-border bg-bg-secondary/90 p-1.5 text-text-secondary transition hover:text-text-primary"
                title="Copy response"
              >
                {copied === 'body' ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
