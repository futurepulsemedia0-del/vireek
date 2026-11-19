// Test-only stand-in for `npm:standardwebhooks@1.0.0` (Vitest cannot resolve the npm: specifier).
// NOT the real library: mirrors its documented behaviour (headers, HMAC-SHA256, ±5 min tolerance).
import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 5 * 60;

export class Webhook {
  private readonly key: Buffer;
  constructor(secretBase64: string) {
    this.key = Buffer.from(secretBase64, 'base64');
  }

  static sign(secretBase64: string, id: string, timestampSeconds: number, payload: string): string {
    const mac = createHmac('sha256', Buffer.from(secretBase64, 'base64')).update(`${id}.${timestampSeconds}.${payload}`).digest('base64');
    return `v1,${mac}`;
  }

  verify(payload: string, headers: Record<string, string>): unknown {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const id = h['webhook-id'];
    const ts = h['webhook-timestamp'];
    const sigs = h['webhook-signature'];
    if (!id || !ts || !sigs) throw new Error('Missing required headers');
    const t = Number(ts);
    if (!Number.isFinite(t)) throw new Error('Invalid timestamp');
    const now = Math.floor(Date.now() / 1000);
    if (now - t > TOLERANCE_SECONDS) throw new Error('Message timestamp too old');
    if (t - now > TOLERANCE_SECONDS) throw new Error('Message timestamp too new');
    const expected = createHmac('sha256', this.key).update(`${id}.${t}.${payload}`).digest();
    for (const part of sigs.split(' ')) {
      const [version, sig] = part.split(',');
      if (version !== 'v1' || !sig) continue;
      const given = Buffer.from(sig, 'base64');
      if (given.length === expected.length && timingSafeEqual(given, expected)) return JSON.parse(payload);
    }
    throw new Error('No matching signature found');
  }
}
