// src/lib/winCardsShare.ts — pure helpers (no DOM) for share links. Unit-tested in winCardsShare.test.ts.

/** Public link of an approved card. Only the opaque token is ever placed in the path. */
export const winCardUrl = (origin: string, token: string) => `${origin.replace(/\/$/, '')}/win/${token}`;
export const winCardImageUrl = (origin: string, token: string, img: 'og' | 'square' | 'story', fmt: 'png' | 'svg' = 'png') =>
  `${origin.replace(/\/$/, '')}/api/win-card?t=${encodeURIComponent(token)}&img=${img}&fmt=${fmt}`;

const enc = encodeURIComponent;

export interface ShareTargets {
  linkedin: string;
  facebook: string;
  x: string;
  teams: string;
  mailto: string;
}

/** Only https URLs are accepted, so a malformed value can never turn into a javascript:/data: share link. */
export function buildShareTargets(url: string, text: string): ShareTargets {
  if (!/^https:\/\//i.test(url)) throw new Error('share url must be https');
  const t = text.slice(0, 240);
  return {
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`,
    x: `https://x.com/intent/post?text=${enc(t)}&url=${enc(url)}`,
    teams: `https://teams.microsoft.com/share?href=${enc(url)}&msgText=${enc(t)}`,
    mailto: `mailto:?subject=${enc(t.slice(0, 120))}&body=${enc(`${t}\n\n${url}`)}`,
  };
}

/** Slack renders the link preview itself from the OG tags, so the message is just caption + link. */
export const slackMessage = (headline: string, caption: string | null, url: string) =>
  [`*${headline.replace(/[*_~`]/g, '')}*`, caption ?? '', url].filter(Boolean).join('\n');

/** Instagram has no web share intent: the flow is download the 1080x1080 / story image and paste the caption. */
export const INSTAGRAM_HINT = 'Instagram has no share link. Download the image, then paste the caption in the app.';
