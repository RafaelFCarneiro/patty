import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../../common/errors.js';
import { guard } from '../../common/result.js';
import { areDifferentAccounts, assertCurrencyMatch, assertNonCreditType, planTransfer } from '../../logic/account.js';
import * as persistence from '../../logic/persistence.js';
import { toIsoDate } from '../../logic/period.js';
import { buildUpsertResult } from '../../logic/transaction.js';
import { accountErrors, type Account, type CreateTransfer } from '../../models/account.js';
import type { FlowOutcome } from '@rfc0/effect-runner';
import {
  TRANSACTION_ENTITY_TAG,
  type UpsertTransactionResult,
  type TransactionSource,
} from '../../models/transaction.js';
import type { Deps } from '../deps.js';
import { resolveAccountRef, resolveDecimals } from '../resolve.js';

const validateTransferAccounts = (from: Account, to: Account) =>
  safeTry(function* () {
    yield* guard(assertNonCreditType(from.type), accountErrors.creditTransferFromRejected(from.name));
    yield* guard(assertNonCreditType(to.type), accountErrors.creditTransferToRejected(to.name));
    yield* guard(areDifferentAccounts(from, to), accountErrors.sameAccount);
    yield* guard(assertCurrencyMatch(from, to), accountErrors.crossCurrencyTransfer(from, to));
    return ok(undefined);
  });

export const createTransfer = (
  deps: Deps,
  input: CreateTransfer,
  source: TransactionSource,
): ResultAsync<FlowOutcome<UpsertTransactionResult>, AppError> =>
  safeTry(async function* () {
    const from = yield* resolveAccountRef(deps, input.from);
    const to = yield* resolveAccountRef(deps, input.to);

    yield* validateTransferAccounts(from, to);

    const { entity, idempotencyKey } = planTransfer({
      id: deps.newId(),
      today: toIsoDate(deps.clock()),
      input,
      from,
      to,
      source,
      decimals: await resolveDecimals(deps, from.currency),
    });

    const locale = await deps.locale();
    const persist = [persistence.insert({ entity: TRANSACTION_ENTITY_TAG, model: entity, idempotencyKey })];
    const response = buildUpsertResult(undefined, locale);
    return ok({ persist, response });
  });
