// supabase/functions/_shared/agent-run/jsonSchema.ts
//
// Minimal, dependency-free JSON-schema subset used to validate tool arguments
// that came from a model (i.e. attacker-influenced input). Strict by design:
//   - unknown properties are REJECTED unless additionalProperties === true
//   - no coercion ("5" is not a number)
//   - strings are length-capped (default 2000) so a prompt-injection payload
//     can't smuggle a novel through a field
// Supported: type, enum, required, properties, additionalProperties, items,
// minLength/maxLength, minimum/maximum, pattern, format:"uuid"|"e164".

export type JsonSchema = {
  type: "object" | "string" | "number" | "integer" | "boolean" | "array";
  enum?: ReadonlyArray<string | number | boolean>;
  required?: readonly string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  items?: JsonSchema;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  format?: "uuid" | "e164";
};

export type ValidationResult<T = Record<string, unknown>> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

const DEFAULT_MAX_STRING = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9]\d{6,14}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function check(value: unknown, schema: JsonSchema, path: string, errors: string[]): unknown {
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`${path}: expected object`);
        return undefined;
      }
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const props = schema.properties ?? {};
      for (const k of Object.keys(src)) {
        if (FORBIDDEN_KEYS.has(k)) {
          errors.push(`${path}.${k}: forbidden key`);
          continue;
        }
        if (!(k in props) && schema.additionalProperties !== true) {
          errors.push(`${path}.${k}: unknown property`);
        }
      }
      for (const r of schema.required ?? []) {
        if (!(r in src) || src[r] === undefined) errors.push(`${path}.${r}: required`);
      }
      for (const [k, sub] of Object.entries(props)) {
        if (src[k] === undefined) continue;
        out[k] = check(src[k], sub, `${path}.${k}`, errors);
      }
      if (schema.additionalProperties === true) {
        for (const k of Object.keys(src)) if (!(k in props) && !FORBIDDEN_KEYS.has(k)) out[k] = src[k];
      }
      return out;
    }
    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array`);
        return undefined;
      }
      const max = schema.maxItems ?? 100;
      if (value.length > max) errors.push(`${path}: more than ${max} items`);
      return schema.items
        ? value.slice(0, max).map((v, i) => check(v, schema.items as JsonSchema, `${path}[${i}]`, errors))
        : value.slice(0, max);
    }
    case "string": {
      if (typeof value !== "string") {
        errors.push(`${path}: expected string`);
        return undefined;
      }
      const max = schema.maxLength ?? DEFAULT_MAX_STRING;
      if (value.length > max) errors.push(`${path}: longer than ${max}`);
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern mismatch`);
      if (schema.format === "uuid" && !UUID_RE.test(value)) errors.push(`${path}: not a uuid`);
      if (schema.format === "e164" && !E164_RE.test(value)) errors.push(`${path}: not an E.164 number`);
      if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: not an allowed value`);
      return value;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`${path}: expected finite number`);
        return undefined;
      }
      if (schema.type === "integer" && !Number.isInteger(value)) errors.push(`${path}: expected integer`);
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
      if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: not an allowed value`);
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
      return value;
    }
    default:
      errors.push(`${path}: unsupported schema type`);
      return undefined;
  }
}

export function validateAgainstSchema<T = Record<string, unknown>>(value: unknown, schema: JsonSchema): ValidationResult<T> {
  const errors: string[] = [];
  const out = check(value, schema, "$", errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: out as T };
}
