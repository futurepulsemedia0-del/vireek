import { useSyncExternalStore } from 'react';
import {
  dismissInstallPrompt,
  getInstallState,
  promptInstall,
  shouldShowInstallBanner,
  subscribeInstallState,
} from '@/lib/pwa/installPrompt';

export function usePwaInstall() {
  const state = useSyncExternalStore(subscribeInstallState, getInstallState, getInstallState);
  return {
    ...state,
    visible: shouldShowInstallBanner(state, Date.now()),
    install: promptInstall,
    dismiss: dismissInstallPrompt,
  };
}
