/**
 * Public warranty registration — client library.
 *
 * The form posts to the `warranty-register` edge function (rate limited,
 * server-validated, sends the confirmation email). Validation here is for
 * instant feedback only; the server and database re-check everything.
 */

import { isValidPassportCode, normalizePassportCode } from '@/lib/equipmentPassport';

export const EQUIPMENT_TYPES = [
  'Air conditioner',
  'Furnace',
  'Heat pump',
  'Mini-split',
  'Boiler',
  'Water heater',
  'Thermostat',
  'Other',
] as const;

export type WarrantyField =
  | 'name'
  | 'email'
  | 'phone'
  | 'address'
  | 'passportCode'
  | 'equipmentType'
  | 'make'
  | 'model'
  | 'serial'
  | 'purchaseDate'
  | 'installDate'
  | 'installer'
  | 'purchasedFrom'
  | 'terms';

export interface WarrantyFormState {
  name: string;
  email: string;
  phone: string;
  address: string;
  passportCode: string;
  equipmentType: string;
  make: string;
  model: string;
  serial: string;
  purchaseDate: string;
  installDate: string;
  installer: string;
  purchasedFrom: string;
  terms: boolean;
  /** Honeypot — must stay empty. */
  website: string;
}

export type WarrantyErrors = Partial<Record<WarrantyField, string>>;

/** Order used to focus the first invalid field. */
export const WARRANTY_FIELD_ORDER: WarrantyField[] = [
  'name', 'email', 'phone', 'address', 'passportCode', 'equipmentType', 'make', 'model',
  'serial', 'purchaseDate', 'installDate', 'installer', 'purchasedFrom', 'terms',
];

export function emptyWarrantyForm(passportCode = ''): WarrantyFormState {
  return {
    name: '', email: '', phone: '', address: '', passportCode,
    equipmentType: '', make: '', model: '', serial: '',
    purchaseDate: '', installDate: '', installer: '', purchasedFrom: '',
    terms: false, website: '',
  };
}

export function todayIso(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isEmail(s: string): boolean {
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export function validateWarrantyForm(form: WarrantyFormState, today: string = todayIso()): WarrantyErrors {
  const e: WarrantyErrors = {};
  const t = (s: string) => s.trim();

  if (t(form.name).length < 2) e.name = 'Enter your full name.';
  else if (t(form.name).length > 120) e.name = 'That name is too long.';

  if (!isEmail(t(form.email))) e.email = 'Enter a valid email address.';

  const phone = t(form.phone);
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    if (!/^[+\d\s().-]+$/.test(phone) || digits.length < 7 || digits.length > 15) e.phone = 'Enter a valid phone number, or leave it empty.';
  }

  if (t(form.address).length > 300) e.address = 'That address is too long.';

  if (t(form.passportCode) && !isValidPassportCode(form.passportCode)) {
    e.passportCode = 'That doesn’t look like a passport code. It’s on the label of your unit (VEQ-XXXX-XXXX-XXXX).';
  }

  if (!form.equipmentType) e.equipmentType = 'Choose the equipment type.';
  if (!t(form.make)) e.make = 'Enter the brand.';
  else if (t(form.make).length > 80) e.make = 'That brand is too long.';
  if (t(form.model).length > 80) e.model = 'That model is too long.';

  const serial = t(form.serial);
  if (serial.length < 4 || serial.length > 60 || !/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(serial)) {
    e.serial = 'Enter the serial number printed on the unit (4–60 letters or digits).';
  }

  const purchase = t(form.purchaseDate);
  if (!isIsoDate(purchase) || purchase > today) e.purchaseDate = 'Enter the purchase date (it can’t be in the future).';

  const install = t(form.installDate);
  if (install && (!isIsoDate(install) || install > today || (isIsoDate(purchase) && install < purchase))) {
    e.installDate = 'The install date must be on or after the purchase date.';
  }

  if (t(form.installer).length > 120) e.installer = 'That name is too long.';
  if (t(form.purchasedFrom).length > 120) e.purchasedFrom = 'That name is too long.';
  if (!form.terms) e.terms = 'Please accept the terms to register.';
  return e;
}

export function firstInvalidField(errors: WarrantyErrors): WarrantyField | null {
  return WARRANTY_FIELD_ORDER.find((f) => errors[f]) ?? null;
}

/** Trimmed payload for the edge function. Empty optionals are dropped. */
export function buildWarrantyPayload(form: WarrantyFormState) {
  const opt = (s: string) => (s.trim() ? s.trim() : undefined);
  return {
    name: form.name.trim(),
    email: form.email.trim().toLowerCase(),
    phone: opt(form.phone),
    address: opt(form.address),
    passportCode: form.passportCode.trim() ? normalizePassportCode(form.passportCode) : undefined,
    equipmentType: form.equipmentType,
    make: form.make.trim(),
    model: opt(form.model),
    serial: form.serial.trim(),
    purchaseDate: form.purchaseDate.trim(),
    installDate: opt(form.installDate),
    installer: opt(form.installer),
    purchasedFrom: opt(form.purchasedFrom),
    termsAccepted: form.terms === true,
    website: form.website,
  };
}

export interface WarrantyReceipt {
  confirmationCode: string;
  passportCode: string | null;
  linked: boolean;
  duplicate: boolean;
  emailSent: boolean;
}

export type WarrantySubmitResult =
  | ({ ok: true } & WarrantyReceipt)
  | { ok: false; kind: 'validation' | 'not_found' | 'rate_limited' | 'network' | 'server'; message: string; fieldErrors?: WarrantyErrors };

const SERVER_MESSAGE = 'We couldn’t save your registration. Please try again in a moment.';

export async function submitWarrantyRegistration(form: WarrantyFormState, signal?: AbortSignal): Promise<WarrantySubmitResult> {
  const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '');
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!base || !anon) return { ok: false, kind: 'server', message: SERVER_MESSAGE };

  let res: Response;
  try {
    res = await fetch(`${base}/functions/v1/warranty-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anon, Authorization: `Bearer ${anon}` },
      body: JSON.stringify(buildWarrantyPayload(form)),
      signal,
    });
  } catch {
    return { ok: false, kind: 'network', message: 'We couldn’t reach the server. Check your connection and try again.' };
  }

  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON error body */
  }

  if (res.ok && data.ok === true && typeof data.confirmationCode === 'string') {
    return {
      ok: true,
      confirmationCode: data.confirmationCode,
      passportCode: typeof data.passportCode === 'string' ? data.passportCode : null,
      linked: data.linked === true,
      duplicate: data.duplicate === true,
      emailSent: data.emailSent === true,
    };
  }

  const message = typeof data.message === 'string' && data.message ? data.message : SERVER_MESSAGE;
  const fieldErrors = (data.fieldErrors ?? undefined) as WarrantyErrors | undefined;
  if (res.status === 429) return { ok: false, kind: 'rate_limited', message };
  if (res.status === 404) return { ok: false, kind: 'not_found', message, fieldErrors };
  if (res.status === 400 || res.status === 413) return { ok: false, kind: 'validation', message, fieldErrors };
  return { ok: false, kind: 'server', message };
}
