import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mayContact, type CustomerPreferences } from "./preferenceCheck.ts";

const base: CustomerPreferences = {
  sms: true, email: true, voice: true, reminders: true, surveys: true, marketing: true,
  language: "en", frequency: "all", unsubscribedAll: false,
};

Deno.test("allows when everything is on", () => assertEquals(mayContact(base, "surveys", "sms").ok, true));
Deno.test("blocks unsubscribed-all", () => assertEquals(mayContact({ ...base, unsubscribedAll: true }, "reminders", "email").ok, false));
Deno.test("blocks a disabled channel only", () => {
  const p = { ...base, sms: false };
  assertEquals(mayContact(p, "surveys", "sms").ok, false);
  assertEquals(mayContact(p, "surveys", "email").ok, true);
});
Deno.test("blocks a disabled category", () => assertEquals(mayContact({ ...base, marketing: false }, "marketing", "email").ok, false));
Deno.test("essential-only blocks marketing/surveys but not reminders", () => {
  const p = { ...base, frequency: "essential" as const };
  assertEquals(mayContact(p, "marketing", "email").ok, false);
  assertEquals(mayContact(p, "surveys", "email").ok, false);
  assertEquals(mayContact(p, "reminders", "email").ok, true);
});
Deno.test("fails closed when preferences cannot be read", () => assertEquals(mayContact("error", "marketing", "sms").ok, false));
