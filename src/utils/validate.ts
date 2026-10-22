import { z } from 'zod';

export type Validated<T> =
  | { ok: true; data: T }
  | { ok: false; errors: Record<string, string[] | undefined> };

export function validate<S extends z.ZodType>(schema: S, input: unknown): Validated<z.infer<S>> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, errors: z.flattenError(result.error).fieldErrors };
}