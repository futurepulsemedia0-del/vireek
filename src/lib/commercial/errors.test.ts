import { describe, it, expect } from 'vitest';
import { friendlyCommercialError } from './errors';

describe('friendlyCommercialError', () => {
  it('maps known codes from Error and plain objects', () => {
    expect(friendlyCommercialError(new Error('amount_exceeds_nte'))).toContain('not-to-exceed');
    expect(friendlyCommercialError({ message: 'x self_approval_not_allowed y' })).toContain('cannot approve');
  });
  it('never leaks raw database text for unknown errors', () => {
    expect(friendlyCommercialError(new Error('duplicate key value violates unique constraint "pg_internal"'))).toBe('Something went wrong. Please try again.');
    expect(friendlyCommercialError(null)).toBe('Something went wrong. Please try again.');
  });
  it("native app origins are matched literally and only when listed", () => {
    expect(isAllowedOrigin("capacitor://localhost")).toBe(false);
    Deno.env.set("CORS_ALLOWED_ORIGINS", "capacitor://localhost, https://localhost");
    expect(isAllowedOrigin("capacitor://localhost")).toBe(true);
    expect(isAllowedOrigin("https://localhost")).toBe(true);
    expect(isAllowedOrigin("capacitor://evil")).toBe(false);
  });
  it("withCors survives responses with immutable headers (fetch() results)", async () => {
    const h = withCors(() => Response.redirect("https://example.com/", 302));
    const res = await h(req("POST", "https://vireek.com"));
    expect(res.headers.get("access-control-allow-origin")).toBe("https://vireek.com");
  });
});
