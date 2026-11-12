/** Anything `typeof` calls an object, arrays included */
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
