import { z } from 'zod';

type Json = Record<string, unknown>;

/**
 * JSON Schema for a tool's input. Generated from zod in "input" mode (so defaulted
 * fields stay optional), then normalized to the conservative shape most MCP clients
 * accept: closed objects and `anyOf` instead of `type` arrays.
 */
export function toInputJsonSchema(schema: z.ZodType): Json {
  const raw = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
  return normalize(raw) as Json;
}

function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (!node || typeof node !== 'object') return node;
  const obj: Json = {};
  for (const [k, v] of Object.entries(node as Json)) obj[k] = normalize(v);
  if (Array.isArray(obj.type)) {
    const types = obj.type as string[];
    delete obj.type;
    const rest = Object.keys(obj).length;
    if (!rest) return { anyOf: types.map((t) => ({ type: t })) };
    obj.anyOf = types.map((t) => ({ type: t }));
  }
  if (obj.type === 'object' && obj.properties && obj.additionalProperties === undefined) obj.additionalProperties = false;
  return obj;
}
