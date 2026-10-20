export const isDatabaseAhead = (lastAppliedMillis: number | undefined, newestKnownMillis: number): boolean =>
  lastAppliedMillis !== undefined && lastAppliedMillis > newestKnownMillis;
