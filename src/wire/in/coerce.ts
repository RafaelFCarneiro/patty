export const coerceToNumber = (v: unknown) => (typeof v === 'string' ? Number(v) : v);
