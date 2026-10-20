/** A drizzle-ish query builder: every chained call returns itself; awaiting it settles with `outcome()`. */
export const query = (outcome: () => Promise<unknown>): unknown => {
  const chain: unknown = new Proxy(
    {},
    { get: (_target, prop) => (prop === 'then' ? (ok: never, bad: never) => outcome().then(ok, bad) : () => chain) },
  );
  return chain;
};

export const settled = (value: unknown) => () => Promise.resolve(value);

export const rejecting = (failure: unknown) => () => Promise.reject(failure);

type Verbs = { insert?: unknown; select?: unknown; update?: unknown; delete?: unknown };

/** A transaction whose insert/select/update/delete each settle with the given result. */
export const txReturning = (verbs: Verbs) =>
  ({
    insert: () => query(settled(verbs.insert ?? {})),
    select: () => query(settled(verbs.select ?? [])),
    update: () => query(settled(verbs.update ?? {})),
    delete: () => query(settled(verbs.delete ?? {})),
  }) as never;

/** A transaction whose every verb fails with `failure`. */
export const txFailing = (failure: unknown) =>
  ({
    insert: () => query(rejecting(failure)),
    select: () => query(rejecting(failure)),
    update: () => query(rejecting(failure)),
    delete: () => query(rejecting(failure)),
  }) as never;
