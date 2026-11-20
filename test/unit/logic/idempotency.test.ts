import { describe, expect, it } from 'vitest';
import * as idempotency from '../../../src/logic/idempotency.js';

describe('idempotency.joinUnambiguously', () => {
  it.each(['|', ',', ':', ' ', '/'])('keeps two field lists apart that a %j join would run together', (separator) => {
    const first = ['acc', `x${separator}y`];
    const second = [`acc${separator}x`, 'y'];
    expect(first.join(separator)).toBe(second.join(separator));
    expect(idempotency.joinUnambiguously(first)).not.toBe(idempotency.joinUnambiguously(second));
  });

  it('tells a missing field from an empty one', () => {
    expect(idempotency.joinUnambiguously(['a', null])).not.toBe(idempotency.joinUnambiguously(['a', '']));
  });
});
