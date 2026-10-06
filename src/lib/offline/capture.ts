// src/lib/offline/capture.ts
// Device capabilities for the field app: photo compression, signature + audio blobs,
// voice recording, barcode / QR scanning, NFC and the GPS trail.
// Every function degrades gracefully when the browser lacks the capability.

import { idb, getMeta, setMeta, notifyData, type PingRecord } from './db';
import { getCachedIdentity } from './identity';

// ------------------------------------------------------------
// Photos
// ------------------------------------------------------------

/** Downscales + re-encodes a camera photo (~8 MB → ~300 KB) so sync works on weak LTE. */
export async function compressImage(file: Blob, maxEdge = 1600, quality = 0.8): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', quality));
    return out && out.size < file.size ? out : file;
  } catch {
    return file;
  }
}

/** data: URL → Blob without fetch() (the app CSP blocks fetch on data: URLs). */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',');
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'image/png';
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// ------------------------------------------------------------
// Voice notes
// ------------------------------------------------------------

export function pickAudioMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

export function isVoiceSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

export interface VoiceRecording {
  stop: () => Promise<{ blob: Blob; durationMs: number; ext: string }>;
  cancel: () => void;
}

export async function startVoiceRecording(): Promise<VoiceRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = pickAudioMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  const startedAt = Date.now();
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const release = () => stream.getTracks().forEach((t) => t.stop());
  recorder.start(1000);

  return {
    stop: () =>
      new Promise((resolve, reject) => {
        recorder.onstop = () => {
          release();
          const type = (recorder.mimeType || mime || 'audio/webm').split(';')[0];
          const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          resolve({ blob: new Blob(chunks, { type }), durationMs: Date.now() - startedAt, ext });
        };
        recorder.onerror = () => {
          release();
          reject(new Error('Recording failed'));
        };
        if (recorder.state !== 'inactive') recorder.stop();
        else {
          release();
          reject(new Error('Recorder already stopped'));
        }
      }),
    cancel: () => {
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
  };
}

// ------------------------------------------------------------
// Barcode / QR (BarcodeDetector: Chrome/Android, Edge, Safari 17+ behind flag)
// ------------------------------------------------------------

interface DetectedBarcode {
  rawValue: string;
  format: string;
}
interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

function getBarcodeCtor(): BarcodeDetectorCtor | null {
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return ctor ?? null;
}

export function isBarcodeSupported(): boolean {
  return getBarcodeCtor() !== null && !!navigator.mediaDevices?.getUserMedia;
}

/** Opens the rear camera in `video` and resolves with the first code seen. */
export async function scanBarcode(
  video: HTMLVideoElement,
  signal: AbortSignal,
): Promise<{ value: string; format: string }> {
  const Ctor = getBarcodeCtor();
  if (!Ctor) throw new Error('Barcode scanning is not supported on this device.');
  const detector = new Ctor();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  await video.play();

  try {
    while (!signal.aborted) {
      const found = await detector.detect(video).catch(() => [] as DetectedBarcode[]);
      if (found.length > 0 && found[0].rawValue) {
        return { value: found[0].rawValue, format: found[0].format };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new DOMException('Scan cancelled', 'AbortError');
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
}

// ------------------------------------------------------------
// NFC (Web NFC: Chrome on Android only; iOS needs the native wrapper)
// ------------------------------------------------------------

interface NdefRecordLike {
  recordType: string;
  data?: DataView;
}
interface NdefReadingEventLike extends Event {
  serialNumber: string;
  message: { records: NdefRecordLike[] };
}
interface NdefReaderLike extends EventTarget {
  scan: (opts?: { signal?: AbortSignal }) => Promise<void>;
}
type NdefReaderCtor = new () => NdefReaderLike;

export function isNfcSupported(): boolean {
  return typeof window !== 'undefined' && 'NDEFReader' in window && window.isSecureContext;
}

export function readNfcTag(signal: AbortSignal): Promise<{ serial: string; records: string[] }> {
  return new Promise((resolve, reject) => {
    const Ctor = (window as unknown as { NDEFReader?: NdefReaderCtor }).NDEFReader;
    if (!Ctor) {
      reject(new Error('NFC is not supported on this device.'));
      return;
    }
    const reader = new Ctor();
    reader.addEventListener('reading', (ev) => {
      const e = ev as NdefReadingEventLike;
      const decoder = new TextDecoder();
      const records = e.message.records
        .filter((r) => r.data && (r.recordType === 'text' || r.recordType === 'url'))
        .map((r) => decoder.decode(r.data));
      resolve({ serial: e.serialNumber, records });
    });
    reader.addEventListener('readingerror', () => reject(new Error('Could not read this tag.')));
    signal.addEventListener('abort', () => reject(new DOMException('Scan cancelled', 'AbortError')));
    reader.scan({ signal }).catch(reject);
  });
}

// ------------------------------------------------------------
// GPS
// ------------------------------------------------------------

export interface Fix {
  lat: number;
  lng: number;
  accuracy: number | null;
  at: number;
}

let lastFix: Fix | null = null;

/** Last known position (no new GPS request). Used to stamp status changes + captures. */
export function getLastKnownFix(maxAgeMs = 10 * 60_000): Fix | null {
  return lastFix && Date.now() - lastFix.at <= maxAgeMs ? lastFix : null;
}

/** Lets the native background tracker keep the "last known position" fresh (used to stamp captures). */
export function recordFix(fix: Fix): void {
  lastFix = fix;
}

export function getCurrentFix(timeoutMs = 8000): Promise<Fix | null> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        lastFix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() };
        resolve(lastFix);
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

/** Fresh fix only if the user already granted location (never triggers a surprise prompt). */
export async function getFixIfPermitted(timeoutMs = 3000): Promise<Fix | null> {
  const recent = getLastKnownFix(2 * 60_000);
  if (recent) return recent;
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' });
    if (status?.state !== 'granted') return null;
  } catch {
    return null;
  }
  return getCurrentFix(timeoutMs);
}

export function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Decides whether a new GPS reading is worth storing (battery + data friendly). */
export function shouldRecordPing(
  prev: { lat: number; lng: number; at: number } | null,
  next: { lat: number; lng: number; at: number; accuracy: number | null },
): boolean {
  if (next.accuracy !== null && next.accuracy > 150) return false;
  if (!prev) return true;
  const dt = next.at - prev.at;
  if (dt < 20_000) return false;
  return distanceMeters(prev.lat, prev.lng, next.lat, next.lng) >= 25 || dt >= 120_000;
}

export const GPS_META_KEY = 'gps_enabled';

export async function isTrackingEnabled(): Promise<boolean> {
  return (await getMeta<boolean>(GPS_META_KEY)) === true;
}

export async function setTrackingEnabled(on: boolean): Promise<void> {
  await setMeta(GPS_META_KEY, on);
  notifyData();
}

/**
 * Foreground GPS trail. Stores deduplicated points in IndexedDB; the sync engine
 * uploads them in batches. (True background tracking needs the native wrapper.)
 */
export function startLocationTracking(getJobId: () => string | null): () => void {
  if (!('geolocation' in navigator)) return () => undefined;
  let prev: { lat: number; lng: number; at: number } | null = null;

  const watchId = navigator.geolocation.watchPosition(
    (p) => {
      const identity = getCachedIdentity();
      const next = {
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        at: Date.now(),
        accuracy: p.coords.accuracy,
      };
      lastFix = { lat: next.lat, lng: next.lng, accuracy: next.accuracy, at: next.at };
      if (!identity || !shouldRecordPing(prev, next)) return;
      prev = next;
      const ping: PingRecord = {
        recorded_at: next.at,
        user_id: identity.userId,
        lat: next.lat,
        lng: next.lng,
        accuracy: next.accuracy,
        speed: p.coords.speed,
        job_id: getJobId(),
      };
      void idb.put('pings', ping).catch(() => undefined);
    },
    () => undefined,
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 30_000 },
  );
  return () => navigator.geolocation.clearWatch(watchId);
}
