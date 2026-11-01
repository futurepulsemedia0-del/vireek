// Provider-agnostic address autocomplete contract. No provider is wired yet:
// implement AddressProvider in a thin client that calls an edge function
// (so the geocoding API key stays server-side), then pass it to <Combobox>
// through addressOptionsLoader().

export interface AddressSuggestion {
  id: string;
  label: string;
  secondary?: string;
}

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2 */
  country: string;
  lat?: number;
  lng?: number;
}

export interface AddressSearchContext {
  signal: AbortSignal;
  /** Restrict results (ISO alpha-2), usually the account's country. */
  country?: string;
  /** Groups keystrokes + the final resolve into one billable session. */
  sessionToken: string;
}

export interface AddressProvider {
  search(query: string, ctx: AddressSearchContext): Promise<AddressSuggestion[]>;
  resolve(suggestionId: string, ctx: AddressSearchContext): Promise<Address>;
}

export function addressOptionsLoader(provider: AddressProvider, opts: { country?: string; sessionToken: () => string }) {
  return async (query: string, signal: AbortSignal) => {
    const found = await provider.search(query, { signal, country: opts.country, sessionToken: opts.sessionToken() });
    return found.map((s) => ({ value: s.id, label: s.label, description: s.secondary }));
  };
}
