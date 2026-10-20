// Account aggregate (ADR-016 step 4): owns the transfer entry point — the two-leg pairing between
// two of its own accounts. Validates (non-credit legs, currency match, distinct accounts), then
// delegates row persistence to the transaction core — the core never depends on this module (the
// reverse is fine and expected). Moved here from controllers/transfers.ts, which predates the
// account/credit-card aggregate split but already had the target shape (ADR-016 §Context).

import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../../common/errors.js';
import { guard } from '../../common/result.js';
import { areDifferentAccounts, assertCurrencyMatch, assertNonCreditType, planTransfer } from '../../logic/account.js';
import * as persistence from '../../logic/persistence.js';
import { toIsoDate } from '../../logic/period.js';
import { buildUpsertResult } from '../../logic/transaction.js';
import { accountErrors } from '../../models/account.js';
import type { Account, CreateTransfer } from '../../models/account.js';
import type { FlowOutcome } from '@rfc0/effect-runner';
import { TRANSACTION_ENTITY_TAG, type UpsertTransactionResult } from '../../models/transaction.js';
import type { TransactionSource } from '../../models/transaction.js';
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

/**
 * A transfer is a Transaction {type: 'transfer'} with FROM and TO account edges (ADR-002).
 * Never classified, never in spending summaries; debits FROM and credits TO balances. Returns the
 * insert as data (ADR-021) — the shell applies it and reports whether it actually landed, which is
 * what `created` reflects.
 */
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
    // Transfers are never classified — explicit `undefined` (purry needs the arity to match
    // `buildUpsertResult`'s 2-arg curry: `classification`, `locale`).
    const response = buildUpsertResult(undefined, locale);
    return ok({ persist, response });
  });
