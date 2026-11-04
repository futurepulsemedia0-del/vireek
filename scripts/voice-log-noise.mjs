// Mixes pink noise into a clean recording at a target signal-to-noise ratio (dB) using ffmpeg.
// Used by eval-voice-log.mjs to measure how extraction degrades in noisy trucks/job sites.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

async function meanVolumeDb(args) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', ...args, '-af', 'volumedetect', '-f', 'null', '-'], { maxBuffer: 16 * 1024 * 1024 }).catch((e) => e);
  const m = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(String(stderr));
  if (!m) throw new Error('could not measure volume');
  return Number(m[1]);
}

export async function durationSeconds(inPath) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', inPath, '-f', 'null', '-'], { maxBuffer: 16 * 1024 * 1024 }).catch((e) => e);
  const m = /time=(\d+):(\d+):([\d.]+)/g;
  let last = null; let x;
  while ((x = m.exec(String(stderr)))) last = x;
  if (!last) throw new Error('could not read duration');
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

/** Writes `outPath` (WAV 16 kHz mono) = clean + pink noise at `snrDb`. */
export async function mixNoise(inPath, outPath, snrDb) {
  const dur = await durationSeconds(inPath);
  const cleanDb = await meanVolumeDb(['-i', inPath]);
  const noiseSrc = `anoisesrc=color=pink:amplitude=0.5:sample_rate=16000:duration=${dur.toFixed(3)}`;
  const noiseDb = await meanVolumeDb(['-f', 'lavfi', '-i', noiseSrc]);
  const gain = cleanDb - snrDb - noiseDb;
  await run('ffmpeg', ['-hide_banner', '-y', '-i', inPath, '-f', 'lavfi', '-i', noiseSrc,
    '-filter_complex', `[0:a]aresample=16000,aformat=channel_layouts=mono[s];[1:a]aformat=channel_layouts=mono,volume=${gain.toFixed(2)}dB[n];[s][n]amix=inputs=2:normalize=0:duration=first[o]`,
    '-map', '[o]', '-ar', '16000', '-ac', '1', outPath]);
  return { cleanDb, noiseDb, gain };
}

export { meanVolumeDb };
