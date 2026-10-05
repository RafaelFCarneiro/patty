import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import { guard } from '../common/result.js';
import * as persistence from '../logic/persistence.js';
import {
  CURRENCY_RATE_ENTITY_TAG,
  currencyRateErrors,
  type CurrencyRateEntity,
  type CurrencyRateView,
  type SetExchangeRateInput,
} from '../models/currencyRate.js';
import type { FlowOutcome } from '@rfc0/effect-runner';
import type { Deps } from './deps.js';

type RateFields = Pick<SetExchangeRateInput, 'from' | 'to' | 'rate' | 'asOf' | 'source'>;

// `fields` is already boundary-decoded (SetExchangeRateSchema at the MCP/REST edge, or
// dbToEntity at the repo edge) — trust it rather than re-validating already-typed internal data
// (docs/code-quality.md "Fail loudly at boundaries, trust internally"). RateFields and
// CurrencyRateView share the same shape, so this is a plain pass-through, not a real adaptation.
const toView = (fields: RateFields): CurrencyRateView => fields;

const entityToFields = (entity: CurrencyRateEntity): RateFields => ({
  from: entity.fromCode,
  to: entity.toCode,
  rate: entity.rate,
  asOf: entity.asOf,
  source: entity.source ?? undefined,
});

/** Upsert-latest (ADR-026 Phase 2): a rate is addressed by its `(from, to)` pair, never by id — an
 *  existing row for the pair is updated in place; a new pair is inserted. `currencyRateApplier`
 *  (diplomat/db/repos/currencyRates.ts) covers the concurrent-first-write race this pre-check alone
 *  can't (two callers both reading "no row yet" for the same pair). */
export const setExchangeRate = (
  deps: Deps,
  input: SetExchangeRateInput,
): ResultAsync<FlowOutcome<CurrencyRateView>, AppError> =>
  safeTry(async function* () {
    yield* guard(input.from !== input.to, currencyRateErrors.samePair);

    const existing = await deps.currencyRates.findByPair(input.from, input.to);
    const fields: RateFields = {
      from: input.from,
      to: input.to,
      rate: input.rate,
      asOf: input.asOf,
      source: input.source,
    };
    const row = {
      fromCode: fields.from,
      toCode: fields.to,
      rate: fields.rate,
      asOf: fields.asOf,
      source: fields.source ?? null,
    };

    const persist = existing
      ? [
          persistence.update({
            entity: CURRENCY_RATE_ENTITY_TAG,
            model: { id: existing.id, ...row, version: existing.version },
          }),
        ]
      : [persistence.insert({ entity: CURRENCY_RATE_ENTITY_TAG, model: { id: deps.newId(), ...row } })];

    return ok({ persist, response: toView(fields) });
  });

export const listExchangeRates = async (deps: Deps): Promise<CurrencyRateView[]> =>
  (await deps.currencyRates.list()).map((entity) => toView(entityToFields(entity)));
