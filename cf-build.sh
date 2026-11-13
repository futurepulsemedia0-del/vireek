#!/usr/bin/env bash
set -e

npm install --legacy-peer-deps

npm install --no-save --legacy-peer-deps --ignore-scripts \
  zod@3 @hookform/resolvers@3 react-hook-form yaml maplibre-gl web-vitals \
  libphonenumber-js @dnd-kit/core @google/model-viewer three@0.183.2 \
  @stripe/stripe-js @stripe/react-stripe-js @sentry/capacitor \
  @capacitor/core @capacitor/app @capacitor/camera @capacitor/filesystem \
  @capacitor/geolocation @capacitor/haptics @capacitor/network @capacitor/share \
  @capacitor/splash-screen @capacitor/status-bar @capacitor/text-zoom \
  @aparajita/capacitor-biometric-auth @aparajita/capacitor-secure-storage \
  @capacitor-community/bluetooth-le @capacitor-community/in-app-review \
  @capacitor-community/stripe-terminal @capacitor-firebase/messaging \
  @capacitor-mlkit/barcode-scanning @capawesome/capacitor-badge \
  @capgo/background-geolocation @capgo/capacitor-nfc

npm run tokens:build
PRERENDER_OPTIONAL=1 npm run build
