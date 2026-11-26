// Zod as Fastify's schema language: one Zod object per route part validates the request,
// checks the response, and is converted to JSON Schema for the OpenAPI document.
import type { FastifySchema, FastifySchemaCompiler, FastifySerializerCompiler } from 'fastify';
import type { SwaggerTransform } from '@fastify/swagger';
import { z } from 'zod';

/**
 * Request parts (body, params, querystring, headers).
 * The ZodError is returned as is: Fastify tags it with `code: 'FST_ERR_VALIDATION'` and the error handler turns it into a 422.
 * `?? {}`: a POST without a body reaches here as undefined; parsing {} reports each missing field by name
 * (`errors.question`) instead of one root-level "expected object".
 */
export const zodValidatorCompiler: FastifySchemaCompiler<z.ZodType> = ({ schema }) => (data) => {
  const result = schema.safeParse(data ?? {});
  return result.success ? { value: result.data } : { error: result.error };
};

/**
 * Responses. A response that doesn't match its schema is our bug, not the client's:
 * it's thrown as a plain Error (→ 500, logged with the Zod issues as `cause`), never as a ZodError,
 * which the error handler would report as the client's 422.
 */
export const zodSerializerCompiler: FastifySerializerCompiler<z.ZodType> = ({ schema, url, method }) => (data) => {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Response of ${method} ${url} does not match its schema`, { cause: result.error });
  }
  return JSON.stringify(result.data);
};

/** Types JSON Schema can't express: a Buffer (multipart file) and a Date (serialized as an ISO string). */
const override: NonNullable<Parameters<typeof z.toJSONSchema>[1]>['override'] = ({ zodSchema, jsonSchema }) => {
  const type = zodSchema._zod.def.type;
  if (type === 'custom') Object.assign(jsonSchema, { type: 'string', format: 'binary' });
  if (type === 'date') Object.assign(jsonSchema, { type: 'string', format: 'date-time' });
};

function toJsonSchema(schema: unknown, io: 'input' | 'output') {
  if (!(schema instanceof z.ZodType)) return schema; // already JSON Schema, or absent
  const json = z.toJSONSchema(schema, { io, unrepresentable: 'any', override });
  delete json.$schema; // a JSON Schema document header, not valid inside an OpenAPI Schema Object
  return json;
}

/**
 * @fastify/swagger `transform`: converts each route's Zod schemas to JSON Schema, only for the docs.
 * Requests are documented as the client sends them (io: 'input'), responses as the server sends them (io: 'output').
 */
export const zodToJsonSchemaTransform: SwaggerTransform = ({ schema, url }) => {
  if (!schema) return { schema, url };
  const { body, params, querystring, headers, response, ...rest } = schema as FastifySchema & { response?: Record<string, unknown> };
  const transformed: Record<string, unknown> = { ...rest };
  for (const [part, value] of Object.entries({ body, params, querystring, headers })) {
    if (value) transformed[part] = toJsonSchema(value, 'input');
  }
  if (response) {
    transformed.response = Object.fromEntries(
      Object.entries(response).map(([code, value]) => [code, toJsonSchema(value, 'output')]),
    );
  }
  return { schema: transformed, url };
};
