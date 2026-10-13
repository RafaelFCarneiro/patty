export const millis = (iso: string): number => Date.parse(iso);
export const toIso = (millisSinceEpoch: number): string => new Date(millisSinceEpoch).toISOString();
