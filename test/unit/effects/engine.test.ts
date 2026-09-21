import { describe, expect, it } from 'vitest';
import { isRetryable, VersionConflict } from '../../../src/effects/engine.js';

// The one new pure decision point the ADR-030 port seam introduces: `applyBatch`
// (`src/effects/engine.ts`) composes it from the `VersionConflict` sentinel the core owns and the
// adapter-supplied `isTransientContention` classifier, with no sqlite-specific import. The full
// retry loop is proven end-to-end against a real SQLite adapter in
// `test/integration/db/effects.test.ts`; this covers just the composition, in isolation.
describe('isRetryable (ADR-030 — the retry decision, decoupled from any concrete adapter)', () => {
  it('retries a VersionConflict regardless of what the adapter classifier says', () => {
    expect(isRetryable(new VersionConflict(), () => false)).toBe(true);
  });

  it('retries a cause the adapter classifies as transient contention', () => {
    const busyLikeCause = new Error('database is locked');
    expect(isRetryable(busyLikeCause, () => true)).toBe(true);
  });

  it('propagates a cause that is neither a VersionConflict nor classified as transient', () => {
    const unrelatedCause = new Error('unique constraint failed');
    expect(isRetryable(unrelatedCause, () => false)).toBe(false);
  });
});
