/**
 * `vireek conformance` — black-box self-test of a Vireek Agent Network endpoint (MCP + A2A).
 * A partner runs it with THEIR key against production or sandbox; no side effects are produced
 * (only reads, malformed requests and a write call that is rejected for its missing idempotency_key).
 */
export type CheckStatus = 'pass' | 'fail' | 'skip';
export interface CheckResult { id: string; name: string; status: CheckStatus; detail?: string }

const SUPPORTED = ['2025-03-26', '2025-06-18', '2025-11-25'];

interface Rpc { status: number; body: any }

export async function runConformance(o: { baseUrl: string; key: string; fetchImpl: typeof fetch }): Promise<CheckResult[]> {
  const base = o.baseUrl.replace(/\/+$/, '');
  const results: CheckResult[] = [];
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}, raw = false, key: string | null = o.key): Promise<Rpc> => {
    const res = await o.fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      body: raw ? (body as string) : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { __unparsable: text.slice(0, 80) }; }
    return { status: res.status, body: parsed };
  };
  const check = async (id: string, name: string, fn: () => Promise<string | void>) => {
    try { const detail = await fn(); results.push({ id, name, status: 'pass', detail: detail || undefined }); }
    catch (e) { results.push({ id, name, status: 'fail', detail: e instanceof Error ? e.message : String(e) }); }
  };
  const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
  const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

  await check('card', 'A2A agent card is public and well-formed', async () => {
    const res = await o.fetchImpl(`${base}/a2a/agent-card`);
    must(res.status === 200, `expected 200, got ${res.status}`);
    const card: any = await res.json();
    for (const f of ['name', 'description', 'url', 'version', 'skills', 'capabilities']) must(card?.[f] !== undefined, `card.${f} missing`);
    must(Array.isArray(card.skills) && card.skills.length > 0, 'card.skills must be a non-empty array');
    must(card.capabilities?.streaming !== true && card.capabilities?.pushNotifications !== true, 'card advertises streaming/push that the server does not implement');
  });

  await check('auth-missing', 'MCP rejects a request without a key (401)', async () => {
    const r = await post('/mcp', rpc('initialize', {}), {}, false, null);
    must(r.status === 401, `expected 401, got ${r.status}`);
  });
  await check('auth-invalid', 'MCP rejects an invalid key (401)', async () => {
    const r = await post('/mcp', rpc('ping'), {}, false, 'vrk_agent_' + 'x'.repeat(40));
    must(r.status === 401, `expected 401, got ${r.status}`);
  });

  let tools: any[] = [];
  await check('initialize', 'initialize returns protocolVersion, capabilities.tools, serverInfo', async () => {
    const r = await post('/mcp', rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vireek-conformance', version: '1' } }));
    must(r.status === 200, `expected 200, got ${r.status}`);
    const res = r.body?.result;
    must(res && SUPPORTED.includes(res.protocolVersion), `unsupported protocolVersion ${res?.protocolVersion}`);
    must(res.capabilities?.tools, 'capabilities.tools missing');
    must(res.serverInfo?.name && res.serverInfo?.version, 'serverInfo incomplete');
  });
  await check('version-negotiation', 'unknown client protocolVersion gets a supported version back', async () => {
    const r = await post('/mcp', rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'c', version: '1' } }));
    must(SUPPORTED.includes(r.body?.result?.protocolVersion), 'server must answer with a version it supports');
  });
  await check('notification', 'notification gets 202 and no body', async () => {
    const r = await post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' });
    must(r.status === 202, `expected 202, got ${r.status}`);
  });
  await check('tools-list', 'tools/list: strict schemas, unique names, descriptions', async () => {
    const r = await post('/mcp', rpc('tools/list'));
    tools = r.body?.result?.tools ?? [];
    must(Array.isArray(tools) && tools.length > 0, 'no tools returned');
    const names = new Set<string>();
    for (const t of tools) {
      must(typeof t.name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(t.name), `bad tool name ${t.name}`);
      must(!names.has(t.name), `duplicate tool ${t.name}`); names.add(t.name);
      must(typeof t.description === 'string' && t.description.length >= 10, `${t.name}: description too short`);
      must(t.inputSchema?.type === 'object', `${t.name}: inputSchema.type must be object`);
      must(t.inputSchema?.additionalProperties === false, `${t.name}: inputSchema must set additionalProperties:false`);
    }
    return `${tools.length} tools`;
  });
  await check('parse-error', 'malformed JSON yields -32700', async () => {
    const r = await post('/mcp', '{not json', {}, true);
    must(r.body?.error?.code === -32700, `expected -32700, got ${JSON.stringify(r.body?.error)}`);
  });
  await check('method-not-found', 'unknown method yields -32601', async () => {
    const r = await post('/mcp', rpc('does/not/exist'));
    must(r.body?.error?.code === -32601, `expected -32601, got ${JSON.stringify(r.body?.error)}`);
  });
  await check('unknown-tool', 'calling an unknown tool is a clean error, not a 5xx', async () => {
    const r = await post('/mcp', rpc('tools/call', { name: 'no_such_tool_xyz', arguments: {} }));
    must(r.status < 500, `got ${r.status}`);
    must(r.body?.error?.code === -32602 || r.body?.result?.isError === true, 'expected -32602 or isError');
  });
  await check('protocol-header', 'invalid MCP-Protocol-Version header is rejected (400)', async () => {
    const r = await post('/mcp', rpc('ping'), { 'mcp-protocol-version': '1999-01-01' });
    must(r.status === 400, `expected 400, got ${r.status}`);
  });
  await check('origin', 'hostile browser Origin is rejected (403)', async () => {
    const r = await post('/mcp', rpc('ping'), { origin: 'https://evil.example' });
    must(r.status === 403, `expected 403, got ${r.status}`);
  });
  const writeTool = tools.find((t) => (t.inputSchema?.required ?? []).includes('idempotency_key'));
  if (!writeTool) {
    results.push({ id: 'write-needs-idempotency', name: 'a write tool without idempotency_key is refused, never executed', status: 'skip', detail: 'no write tool visible to this key' });
  } else {
    await check('write-needs-idempotency', 'a write tool without idempotency_key is refused, never executed', async () => {
      const r = await post('/mcp', rpc('tools/call', { name: writeTool.name, arguments: {} }));
      must(r.body?.error || r.body?.result?.isError === true, `${writeTool.name} accepted a call with no arguments`);
    });
  }
  await check('a2a-task-not-found', 'A2A tasks/get on an unknown task yields -32001', async () => {
    const r = await post('/a2a', rpc('tasks/get', { id: '00000000-0000-4000-8000-000000000000' }));
    must(r.body?.error?.code === -32001, `expected -32001, got ${JSON.stringify(r.body?.error)}`);
  });
  await check('a2a-push', 'A2A push notifications are declared unsupported (-32003)', async () => {
    const r = await post('/a2a', rpc('tasks/pushNotificationConfig/set', { taskId: 'x', pushNotificationConfig: { url: 'https://example.com' } }));
    must(r.body?.error?.code === -32003, `expected -32003, got ${JSON.stringify(r.body?.error)}`);
  });
  return results;
}

export function summarize(results: CheckResult[]) {
  return { passed: results.filter((r) => r.status === 'pass').length, failed: results.filter((r) => r.status === 'fail').length, skipped: results.filter((r) => r.status === 'skip').length };
}
