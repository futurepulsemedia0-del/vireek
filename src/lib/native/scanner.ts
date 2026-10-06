// src/lib/native/scanner.ts
// Native barcode / QR scanning (Google ML Kit). The web build has no BarcodeDetector inside
// iOS / Android WebViews, so the installed app uses the real scanner instead.

import { nativePlatform } from './platform';

const MODULE_INSTALL_TIMEOUT_MS = 60_000;

export async function isNativeScanSupported(): Promise<boolean> {
  const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
  return (await BarcodeScanner.isSupported()).supported;
}

/** Android only: the scanner UI ships as a Google Play Services module that may need a one-time download. */
async function ensureAndroidModule(): Promise<void> {
  if (nativePlatform() !== 'android') return;
  const { BarcodeScanner, GoogleBarcodeScannerModuleInstallState } = await import('@capacitor-mlkit/barcode-scanning');
  if ((await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()).available) return;

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      void handle.then((h) => h.remove());
      reject(new Error('The scanner module could not be installed. Connect to the internet once and try again.'));
    }, MODULE_INSTALL_TIMEOUT_MS);

    const handle = BarcodeScanner.addListener('googleBarcodeScannerModuleInstallProgress', (event) => {
      if (event.state === GoogleBarcodeScannerModuleInstallState.COMPLETED) {
        window.clearTimeout(timer);
        void handle.then((h) => h.remove());
        resolve();
      } else if (
        event.state === GoogleBarcodeScannerModuleInstallState.FAILED ||
        event.state === GoogleBarcodeScannerModuleInstallState.CANCELED
      ) {
        window.clearTimeout(timer);
        void handle.then((h) => h.remove());
        reject(new Error('The scanner module could not be installed.'));
      }
    });
    BarcodeScanner.installGoogleBarcodeScannerModule().catch((e: unknown) => {
      window.clearTimeout(timer);
      void handle.then((h) => h.remove());
      reject(e instanceof Error ? e : new Error('Scanner install failed'));
    });
  });
}

/** Opens the native scanner. Rejects with an AbortError when the user closes it. */
export async function scanNativeCode(): Promise<{ value: string; format: string }> {
  const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');

  const perm = await BarcodeScanner.requestPermissions();
  if (perm.camera !== 'granted' && perm.camera !== 'limited') {
    throw new Error('Camera permission is needed to scan codes.');
  }
  await ensureAndroidModule();

  let result;
  try {
    result = await BarcodeScanner.scan({ autoZoom: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/cancel/i.test(message)) throw new DOMException('Scan cancelled', 'AbortError');
    throw e;
  }
  const code = result.barcodes[0];
  const value = code?.rawValue || code?.displayValue;
  if (!code || !value) throw new DOMException('Scan cancelled', 'AbortError');
  return { value, format: String(code.format) };
}
