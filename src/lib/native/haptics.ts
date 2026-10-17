// src/lib/native/haptics.ts — tactile feedback in the installed app; a silent no-op on the web.

import { isNative } from './platform';

export type HapticKind = 'success' | 'error' | 'warning' | 'info';

export async function haptic(kind: HapticKind = 'info'): Promise<void> {
  if (!isNative()) return;
  try {
    const { Haptics, ImpactStyle, NotificationType } = await import('@capacitor/haptics');
    if (kind === 'info') await Haptics.impact({ style: ImpactStyle.Light });
    else if (kind === 'success') await Haptics.notification({ type: NotificationType.Success });
    else if (kind === 'warning') await Haptics.notification({ type: NotificationType.Warning });
    else await Haptics.notification({ type: NotificationType.Error });
  } catch {
    /* device without a haptic engine */
  }
}
