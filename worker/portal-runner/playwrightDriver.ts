// worker/portal-runner/playwrightDriver.ts
// BrowserDriver backed by Playwright. Runs ONLY inside the isolated worker container (never in an edge function / the web app).
// NOT RUN in the authoring environment (no Playwright/browsers installed). The framework logic it plugs into IS unit-tested.
import type { Page } from '@playwright/test';
import type { BrowserDriver, ChallengeKind } from '../../supabase/functions/_shared/portal/recipe.ts';

const CHALLENGE_SELECTORS: ReadonlyArray<readonly [ChallengeKind, string]> = [
  ['mfa', '[data-challenge="mfa"], input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="mfa" i]'],
  ['captcha', '[data-challenge="captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, .cf-turnstile'],
];

export class PlaywrightDriver implements BrowserDriver {
  private page: Page;
  private shotDir: string;
  private nav: { timeoutMs: number };
  constructor(page: Page, shotDir: string, timeoutMs = 15_000) { this.page = page; this.shotDir = shotDir; this.nav = { timeoutMs }; }

  async goto(url: string): Promise<void> { await this.page.goto(url, { timeout: this.nav.timeoutMs, waitUntil: 'domcontentloaded' }); }
  async currentHost(): Promise<string> { const u = this.page.url(); try { return u && u !== 'about:blank' ? new URL(u).host : ''; } catch { return ''; } }
  async exists(selector: string): Promise<boolean> { return (await this.page.locator(selector).first().count()) > 0; }
  async fill(selector: string, text: string): Promise<void> { await this.page.locator(selector).first().fill(text, { timeout: this.nav.timeoutMs }); }
  async click(selector: string): Promise<void> {
    await Promise.all([this.page.waitForLoadState('domcontentloaded').catch(() => undefined), this.page.locator(selector).first().click({ timeout: this.nav.timeoutMs })]);
  }
  async text(selector: string): Promise<string> { return (await this.page.locator(selector).first().innerText({ timeout: this.nav.timeoutMs })) ?? ''; }
  async screenshot(name: string, maskSelectors: string[]): Promise<string> {
    const path = `${this.shotDir}/${Date.now()}-${name}.png`;
    // mask = Playwright paints an opaque box over every matched element BEFORE the pixels are captured
    await this.page.screenshot({ path, mask: maskSelectors.map((s) => this.page.locator(s)), maskColor: '#000000', fullPage: false });
    return path;
  }
  async detectChallenge(): Promise<ChallengeKind | null> {
    for (const [kind, sel] of CHALLENGE_SELECTORS) if ((await this.page.locator(sel).count()) > 0) return kind;
    return null;
  }
}
