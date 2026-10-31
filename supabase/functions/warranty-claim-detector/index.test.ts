import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isAuthorized, safeEqual } from "./auth.ts";

Deno.test("safeEqual", () => {
  assertEquals(safeEqual("abc", "abc"), true);
  assertEquals(safeEqual("abc", "abd"), false);
  assertEquals(safeEqual("abc", "abcd"), false);
});

Deno.test("isAuthorized rejects missing secret or header", () => {
  assertEquals(isAuthorized(undefined, "x"), false);
  assertEquals(isAuthorized("s", null), false);
  assertEquals(isAuthorized("s", "wrong"), false);
  assertEquals(isAuthorized("s", "s"), true);
});
