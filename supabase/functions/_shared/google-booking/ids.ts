// Shared id helpers for the Google feed and the Booking Server (must stay identical on both sides).
export const serviceIdFor = (name: string): string =>
  "svc_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
