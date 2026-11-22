// _shared/http/zod.ts — the ONE place that pins zod for Edge Functions (same version as package.json).
// Vitest resolves the npm: specifier through the alias in vite.config.ts.
import { z } from "npm:zod@3.25.76";

export { z };
export type { ZodTypeAny } from "npm:zod@3.25.76";

/** Request schemas MUST reject unknown keys: use this instead of z.object(). */
export const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

/** For endpoints that take no input (cron / feeds): any extra field or query param is a 400. */
export const emptyObject = z.object({}).strict();

export const slug = z.string().regex(/^[a-z0-9-]{3,60}$/, "Invalid slug.");
export const uuid = z.string().uuid();
export const boundedString = (max: number, min = 1) => z.string().trim().min(min).max(max);
