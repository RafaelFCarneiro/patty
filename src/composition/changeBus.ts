import type { ChangeEvent, UserChangeBus } from '../models/tenancy.js';

/**
 * In-process pub/sub for committed-change notifications (ADR-033 §5): every event names the user it belongs to, and a
 * subscriber filters on it, so one user's writes are never announced to another's browser. A plain `Set` — no
 * dependencies, no listener cap. A listener that throws never fails the write it hears about, nor the listeners after
 * it: its failure goes to `onError` (the post-commit notification must never turn a committed write into an error).
 */
export const createUserChangeBus = (onError: (cause: unknown) => void = () => undefined): UserChangeBus => {
  const listeners = new Set<(event: ChangeEvent) => void>();
  const isolated = (work: () => unknown): void => {
    try {
      const result = work();
      if (result instanceof Promise) result.catch(onError);
    } catch (cause) {
      onError(cause);
    }
  };
  return {
    publish: (event) => {
      for (const listener of [...listeners]) isolated(() => listener(event));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
};
