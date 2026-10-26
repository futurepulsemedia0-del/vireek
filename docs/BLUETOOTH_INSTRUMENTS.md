# Bluetooth instruments (job forms)

Technicians can fill a **number** field straight from a Bluetooth LE instrument. The button
("Read from device") appears only when (a) the app / browser can do Bluetooth, (b) the field's
`unit` maps to a quantity (`°F`, `°C`, `%RH`, `psi`, `V`, `A` …) and (c) at least one registered
profile can supply that quantity. Typing a value always works; a failed read never blocks a form.

| File | Role |
| --- | --- |
| `src/lib/native/measurements.ts` | Units, conversion, standard GATT decoders, provenance string (pure) |
| `src/lib/native/instruments.ts` | Profile registry — **the one place to add an instrument** (pure) |
| `src/lib/native/bluetooth.ts` | Picker → connect → first valid value → always disconnect |
| `src/components/forms/BluetoothReadingButton.tsx` | UI states |
| `answers["<field>__source"]` | `bluetooth \| <device> \| <ISO time>` — set only for instrument readings |

## Built in (standard Bluetooth SIG profiles)

Health Thermometer (temperature), Environmental Sensing (temperature, humidity, barometric
pressure). Gauge pressure (`psi`, `kPa`, `bar`), voltage and current have **no** standard
profile, so those fields show no button until a vendor profile is registered.

## Adding a vendor profile

Take the service / characteristic UUIDs and the byte layout from the manufacturer's protocol
document or SDK — never from guesses. Then:

```ts
// e.g. in src/main.tsx, once at startup
import { registerInstrumentProfile } from '@/lib/native/instruments';

registerInstrumentProfile({
  id: 'acme-gauge-pressure',
  label: 'Acme digital gauge',
  quantity: 'pressure_gauge',            // value must be returned in Pa
  service: '<128-bit service uuid>',
  characteristic: '<128-bit characteristic uuid>',
  decode: (view) => { /* parse per vendor doc */ return { quantity: 'pressure_gauge', value: pa }; },
});
```

Add a unit test with a **captured packet** next to the decoder.

## Native setup

iOS `Info.plist`: `NSBluetoothAlwaysUsageDescription`. Android: `BLUETOOTH_SCAN` (with
`neverForLocation`) and `BLUETOOTH_CONNECT`. `npm run mobile:preflight` checks both.
Update the store privacy answers (`docs/store/privacy-data-map.md`): Bluetooth is used only to read
a technician-selected instrument; no data leaves the device except the stored form answer.
