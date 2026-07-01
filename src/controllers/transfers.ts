import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import { guard } from '../common/result.js';
import { areDifferentAccounts, assertCurrencyMatch, assertNonCreditType } from '../logic/account.js';
import { toIsoDate } from '../logic/period.js';
import { addLocalizedLabels, defaultStatusFor } from '../logic/transaction.js';
import { accountErrors } from '../models/account.js';
import type { Account } from '../models/account.js';
import { ClassificationMethod, TransactionType } from '../models/transaction.js';
import type { CreateTransfer, TransactionView, TransactionSource } from '../models/transaction.js';
import type { Deps } from './deps.js';
import { resolveAccountRef } from './resolve.js';

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
 * Never classified, never in spending summaries; debits FROM and credits TO balances.
 */
export const createTransfer = (
  deps: Deps,
  input: CreateTransfer,
  source: TransactionSource,
): ResultAsync<{ transaction: TransactionView; created: boolean }, AppError> =>
  safeTry(async function* () {
    const from = yield* resolveAccountRef(deps, input.from);
    const to = yield* resolveAccountRef(deps, input.to);

    yield* validateTransferAccounts(from, to);

    const today = toIsoDate(deps.clock());
    const date = input.date ?? today;
    const { transaction, created } = await deps.transactions.create(
      {
        id: deps.newId(),
        description: input.description ?? `Transferência: ${from.name} → ${to.name}`,
        amount: input.amount,
        type: TransactionType.enum.transfer,
        status: input.status ?? defaultStatusFor(date, today),
        date,
        currency: from.currency,
        source,
        idempotencyKey: input.idempotencyKey,
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { accountId: from.id, toAccountId: to.id },
      },
      [],
    );
    const locale = await deps.locale();
    return ok({ transaction: addLocalizedLabels(transaction, locale), created });
  });
