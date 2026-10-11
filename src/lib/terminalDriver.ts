// Native Tap to Pay adapter. This is the ONLY file that touches the Capacitor Stripe Terminal plugin.
// Plugin: @capacitor-community/stripe-terminal (verify method/enum names against its typings; see notes).
import { Capacitor } from '@capacitor/core';
import * as TerminalModule from '@capacitor-community/stripe-terminal';
import { fetchConnectionToken } from '@/lib/inPersonPayments';

export interface TapToPayDriver {
  isSupported(): boolean;
  /** Initializes the SDK and connects the phone's built-in Tap to Pay reader (idempotent). */
  prepare(): Promise<void>;
  /** Presents the Tap to Pay sheet, collects the card and confirms the PaymentIntent. */
  collectAndConfirm(clientSecret: string): Promise<void>;
  cancel(): Promise<void>;
}

type PluginShape = {
  initialize(o: { isTest: boolean }): Promise<unknown>;
  setConnectionToken(o: { token: string }): Promise<unknown>;
  discoverReaders(o: { type: string; locationId?: string }): Promise<unknown>;
  connectReader(o: { reader: unknown; locationId?: string }): Promise<unknown>;
  collectPaymentMethod(o: { paymentIntent: string }): Promise<unknown>;
  confirmPaymentIntent(): Promise<unknown>;
  cancelCollectPaymentMethod?: () => Promise<unknown>;
  cancelDiscoverReaders?: () => Promise<unknown>;
  addListener(event: string, cb: (e: { readers?: unknown[] }) => void): Promise<{ remove: () => Promise<void> }>;
};

const mod = TerminalModule as unknown as { StripeTerminal: PluginShape; TerminalEventsEnum?: Record<string, string> };
const T = mod.StripeTerminal;
const DISCOVERED_EVENT = mod.TerminalEventsEnum?.DiscoveredReaders ?? 'terminalDiscoveredReaders';
const REQUIRED: Array<keyof PluginShape> = ['initialize', 'setConnectionToken', 'discoverReaders', 'connectReader', 'collectPaymentMethod', 'confirmPaymentIntent', 'addListener'];

let initialized = false;
let connected = false;
let preparing: Promise<void> | null = null;

function assertPluginShape() {
  const missing = REQUIRED.filter((k) => typeof T?.[k] !== 'function');
  if (missing.length) throw new Error(`Stripe Terminal plugin API mismatch (missing: ${missing.join(', ')}). Check src/lib/terminalDriver.ts against the installed plugin typings.`);
}

async function discoverTapToPayReader(locationId: string): Promise<unknown> {
  let handle: { remove: () => Promise<void> } | null = null;
  try {
    const found = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Could not find the Tap to Pay reader on this device.')), 20_000);
      T.addListener(DISCOVERED_EVENT, (e) => {
        if (e.readers && e.readers.length > 0) { clearTimeout(timer); resolve(e.readers[0]); }
      }).then((h) => { handle = h; }).catch(reject);
    });
    await T.discoverReaders({ type: 'tap-to-pay', locationId });
    return await found;
  } finally {
    try { await handle?.remove(); } catch { /* ignore */ }
    try { await T.cancelDiscoverReaders?.(); } catch { /* ignore */ }
  }
}

async function doPrepare() {
  assertPluginShape();
  const { secret, location_id, is_test } = await fetchConnectionToken();
  if (!initialized) { await T.initialize({ isTest: is_test }); initialized = true; }
  await T.setConnectionToken({ token: secret });
  if (connected) return;
  const reader = await discoverTapToPayReader(location_id);
  await T.connectReader({ reader, locationId: location_id });
  connected = true;
}

export const tapToPayDriver: TapToPayDriver = {
  isSupported: () => Capacitor.isNativePlatform(),
  prepare() {
    preparing ??= doPrepare().finally(() => { preparing = null; });
    return preparing;
  },
  async collectAndConfirm(clientSecret) {
    assertPluginShape();
    await T.collectPaymentMethod({ paymentIntent: clientSecret });
    await T.confirmPaymentIntent();
  },
  async cancel() {
    try { await T.cancelCollectPaymentMethod?.(); } catch { /* nothing in flight */ }
  },
};
