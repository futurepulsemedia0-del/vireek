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

// "Vireek Home" is a separate app (own bundle id + native projects) built from the same code:
//   VIREEK_APP=home  →  see scripts/cap-home.mjs
const isHome = process.env.VIREEK_APP === 'home';

export default isHome
  ? {
      ...config,
      appId: 'com.vireek.home',
      appName: 'Vireek Home',
      webDir: 'dist-home',
      ios: { path: 'ios-home' },
      android: { ...config.android, path: 'android-home' },
    }
  : config;
