// Calls the `browser-extension` edge function with the signed-in user's JWT.

export class ApiError extends Error {
  constructor(status, code, message, data = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export const newRequestId = () =>
  (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  ).slice(0, 64);

export function createApi({ config, session, fetchImpl = fetch }) {
  const url = `${config.SUPABASE_URL}/functions/v1/browser-extension`;
  const send = (token, action, body) =>
    fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...body, action }),
    });

  return async function call(action, body = {}) {
    let token = await session.getAccessToken();
    let res;
    try {
      res = await send(token, action, body);
      if (res.status === 401) {
        token = await session.refresh();
        res = await send(token, action, body);
      }
    } catch (e) {
      if (e?.code) throw e; // AuthError from refresh
      throw new ApiError(0, 'network', 'network');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.code ?? 'error', data.error ?? 'error', data);
    return data;
  };
}
