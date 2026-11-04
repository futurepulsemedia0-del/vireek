import { describe, expect, it } from 'vitest';
import { buildShareTargets, slackMessage, winCardImageUrl, winCardUrl } from './winCardsShare';

const TOKEN = 'A'.repeat(43);
describe('winCardsShare', () => {
  it('builds public urls from the token only', () => {
    expect(winCardUrl('https://app.vireek.com/', TOKEN)).toBe(`https://app.vireek.com/win/${TOKEN}`);
    expect(winCardImageUrl('https://app.vireek.com', TOKEN, 'og')).toBe(`https://app.vireek.com/api/win-card?t=${TOKEN}&img=og&fmt=png`);
  });
  it('encodes the url and text and caps the text length', () => {
    const t = buildShareTargets(`https://app.vireek.com/win/${TOKEN}`, 'Café & "quotes" ' + 'x'.repeat(400));
    expect(t.x).toContain('x.com/intent/post');
    expect(t.x).not.toContain(' ');
    expect(decodeURIComponent(t.x.split('text=')[1].split('&url=')[0]).length <= 240).toBe(true);
    expect(t.linkedin).toContain(encodeURIComponent(`https://app.vireek.com/win/${TOKEN}`));
  });
  it('refuses non-https urls', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://insecure.example', '//evil.example']) expect(() => buildShareTargets(bad, 't')).toThrow();
  });
  it('slack message strips formatting characters from the headline', () => {
    expect(slackMessage('A *bold* _claim_', null, 'https://x.y/z')).toBe('*A bold claim*\nhttps://x.y/z');
  });
});
