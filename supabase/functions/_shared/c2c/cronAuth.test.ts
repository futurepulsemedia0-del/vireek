import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isCronAuthorized } from "./cronAuth.ts";

const SECRET = "0123456789abcdef0123";

Deno.test("rejects when server secret is unset or too short (fail closed)", () => {
  assertEquals(isCronAuthorized(undefined, SECRET), false);
  assertEquals(isCronAuthorized("", ""), false);
  assertEquals(isCronAuthorized("short", "short"), false);
});

Deno.test("rejects missing or wrong header", () => {
  assertEquals(isCronAuthorized(SECRET, null), false);
  assertEquals(isCronAuthorized(SECRET, "nope"), false);
  assertEquals(isCronAuthorized(SECRET, SECRET + "x"), false);
});

Deno.test("accepts exact secret", () => {
  assertEquals(isCronAuthorized(SECRET, SECRET), true);
});
