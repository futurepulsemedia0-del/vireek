// src/lib/holdAudio.ts
//
// Original, license-safe hold audio: a soft generative pad synthesized from
// sine waves (no samples, no third-party music). Loops seamlessly because every
// partial and every amplitude LFO completes an integer number of cycles in the
// clip. Output: 16-bit mono PCM WAV (8 kHz telephony default).

export type HoldStyle = "calm" | "warm" | "bright";

export interface HoldAudioOptions {
  style?: HoldStyle;
  durationSec?: number; // 10..120
  sampleRate?: 8000 | 16000;
}

const CHORDS: Record<HoldStyle, number[]> = {
  calm: [196.0, 246.94, 293.66, 392.0], // G major-ish, low and soft
  warm: [220.0, 277.18, 329.63, 440.0], // A major
  bright: [261.63, 329.63, 392.0, 523.25], // C major
};

export const HOLD_TARGET_RMS = 0.1; // about -20 dBFS
export const HOLD_PEAK_LIMIT = 0.6;

export function clampHoldOptions(o: HoldAudioOptions = {}): Required<HoldAudioOptions> {
  const d = Number.isFinite(o.durationSec) ? Math.round(o.durationSec as number) : 30;
  return {
    style: o.style && o.style in CHORDS ? o.style : "calm",
    durationSec: Math.min(120, Math.max(10, d)),
    sampleRate: o.sampleRate === 16000 ? 16000 : 8000,
  };
}

export function synthesizeHoldAudio(opts: HoldAudioOptions = {}): Float32Array {
  const { style, durationSec, sampleRate } = clampHoldOptions(opts);
  const n = durationSec * sampleRate;
  const out = new Float32Array(n);
  CHORDS[style].forEach((f0, i) => {
    // Snap frequency to an integer number of cycles over the clip → perfect loop.
    const cycles = Math.max(1, Math.round(f0 * durationSec));
    const f = cycles / durationSec;
    // Slow amplitude LFO, integer cycles over the clip, offset per voice.
    const lfoCycles = Math.max(2, Math.round(durationSec / (7 + i * 1.7)));
    const phase = (i * Math.PI) / 3;
    for (let k = 0; k < n; k++) {
      const t = k / sampleRate;
      const lfo = 0.6 + 0.4 * Math.sin((2 * Math.PI * lfoCycles * t) / durationSec + phase);
      out[k] += lfo * Math.sin(2 * Math.PI * f * t) * (1 / (1 + i * 0.35));
    }
  });
  // Normalize to target RMS, then hard-limit peaks.
  let sum = 0;
  for (let k = 0; k < n; k++) sum += out[k] * out[k];
  const rms = Math.sqrt(sum / n) || 1;
  const gain = HOLD_TARGET_RMS / rms;
  for (let k = 0; k < n; k++) out[k] = Math.max(-HOLD_PEAK_LIMIT, Math.min(HOLD_PEAK_LIMIT, out[k] * gain));
  return out;
}

export function analyzeAudio(samples: Float32Array): { rms: number; peak: number } {
  let sum = 0;
  let peak = 0;
  for (const s of samples) {
    sum += s * s;
    peak = Math.max(peak, Math.abs(s));
  }
  return { rms: Math.sqrt(sum / (samples.length || 1)), peak };
}

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, dataBytes, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 32767), true));
  return new Uint8Array(buf);
}

export function generateHoldWav(opts: HoldAudioOptions = {}): { bytes: Uint8Array; fileName: string; durationSec: number } {
  const o = clampHoldOptions(opts);
  return { bytes: encodeWav(synthesizeHoldAudio(o), o.sampleRate), fileName: `vireek-hold-${o.style}-${o.durationSec}s.wav`, durationSec: o.durationSec };
}
