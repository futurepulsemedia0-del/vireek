import Vapi from '@vapi-ai/web';

/**
 * Vapi PUBLIC key (safe to expose in client-side code — this is the
 * browser-scoped key, not the private/server key). Get it from:
 * Vapi dashboard → your account → API Keys → Public Key.
 *
 * Set it in your .env file as VITE_VAPI_PUBLIC_KEY (see .env.example).
 */
const VAPI_PUBLIC_KEY = import.meta.env.VITE_VAPI_PUBLIC_KEY as string | undefined;

/**
 * The dedicated "Vireek Demo — Landing Page" assistant in Vapi.
 *
 * This is intentionally a SEPARATE assistant from the production dispatch
 * line ("Vireek Receptionist"). It runs the demo-mode system prompt, has
 * no `lookup_customer` / `book_appointment` tools connected, and is safe
 * to expose to anonymous website visitors.
 *
 * Override via VITE_VAPI_DEMO_ASSISTANT_ID if you ever recreate the demo
 * assistant and get a new ID.
 */
export const VAPI_DEMO_ASSISTANT_ID: string =
  (import.meta.env.VITE_VAPI_DEMO_ASSISTANT_ID as string | undefined) ??
  '7d57bc95-95b7-4024-b193-081a7f3efb9a';

let vapiInstance: Vapi | null = null;

/**
 * Lazily creates (once) and returns the shared Vapi browser client.
 * Throws a clear, actionable error if the public key hasn't been configured
 * yet, so the UI can show a helpful message instead of a blank failure.
 */
export function getVapiClient(): Vapi {
  if (!VAPI_PUBLIC_KEY) {
    throw new Error(
      'Voice demo is not configured yet: missing VITE_VAPI_PUBLIC_KEY. Add it to your .env file — get it from the Vapi dashboard under API Keys (use the PUBLIC key, never the private/secret one).'
    );
  }
  if (!vapiInstance) {
    vapiInstance = new Vapi(VAPI_PUBLIC_KEY);
  }
  return vapiInstance;
}
