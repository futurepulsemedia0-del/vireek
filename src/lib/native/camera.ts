// src/lib/native/camera.ts — native camera capture (system permission prompt, correct orientation).
// Returns null when the user cancels. The website keeps using <input capture>.

import { isNative } from './platform';

export async function takeNativePhoto(): Promise<File | null> {
  if (!isNative()) return null;
  const { Camera, CameraDirection } = await import('@capacitor/camera');

  let result;
  try {
    result = await Camera.takePhoto({
      quality: 85,
      targetWidth: 2048,
      targetHeight: 2048,
      correctOrientation: true,
      saveToGallery: false,
      cameraDirection: CameraDirection.Rear,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/cancel/i.test(message)) return null;
    throw e;
  }

  const url = result.webPath ?? result.uri;
  if (!url) return null;
  const blob = await (await fetch(url)).blob();
  return new File([blob], `photo-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' });
}
