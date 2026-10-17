import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.vireek.field',
  appName: 'Vireek Field',
  webDir: 'dist',
  backgroundColor: '#000000',
  android: {
    // Keeps JavaScript (and therefore GPS callbacks) alive while the app is in the background.
    useLegacyBridge: true,
  },
  plugins: {
    // Hidden by src/lib/native/shell.ts after the first paint.
    SplashScreen: { launchAutoHide: false, backgroundColor: '#000000', showSpinner: false },
    FirebaseMessaging: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
