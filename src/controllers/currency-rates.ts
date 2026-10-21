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
  type RateFields,
} from '../models/currency-rate.js';
import type { FlowOutcome } from '@rfc0/effect-runner';
import type { Deps } from './deps.js';

const toView = (fields: RateFields): CurrencyRateView => fields;

const entityToFields = (entity: CurrencyRateEntity): RateFields => ({
  from: entity.fromCode,
  to: entity.toCode,
  rate: entity.rate,
  asOf: entity.asOf,
  source: entity.source ?? undefined,
});

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
