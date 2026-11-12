/** A plain object's fields, to be checked one by one. Not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Anything `typeof` calls an object, arrays included */
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
