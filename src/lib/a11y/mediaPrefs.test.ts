import { afterEach, describe, expect, it } from 'vitest';
import { startMediaPrefs } from './mediaPrefs';

afterEach(() => { document.body.innerHTML = ''; });

describe('startMediaPrefs', () => {
  it('does nothing (returns undefined) when both preferences are off', () => {
    expect(startMediaPrefs({ mute: false, captions: false })).toBeUndefined();
  });
  it('mutes existing and later-added media, keeps them muted, and restores on cleanup', async () => {
    document.body.innerHTML = '<video id="a"></video>';
    const a = document.getElementById('a') as HTMLVideoElement;
    const stop = startMediaPrefs({ mute: true, captions: false });
    expect(a.muted).toBe(true);
    a.muted = false;
    a.dispatchEvent(new Event('volumechange'));
    expect(a.muted).toBe(true);
    const b = document.createElement('audio');
    document.body.appendChild(b);
    await Promise.resolve();
    expect(b.muted).toBe(true);
    stop?.();
    expect(a.muted).toBe(false);
  });
});
