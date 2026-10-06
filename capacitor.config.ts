import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.vireek.field',
  appName: 'Vireek Field',
  webDir: 'dist',
  android: {
    // Keeps JavaScript (and therefore GPS callbacks) alive while the app is in the background.
    useLegacyBridge: true,
  },
};

export default config;
