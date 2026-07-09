import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../../common/errors.js';
import { okOr } from '../../common/result.js';
import { addLocalizedLabels } from '../../logic/transaction.js';
import { TransactionStatus, transactionErrors, type TransactionView } from '../../models/transaction.js';
import type { Deps } from '../deps.js';

/** Flip a pending transaction to effective. No-op (returns existing) if already effective. */
export const confirmTransaction = (deps: Deps, input: { id: string }): ResultAsync<TransactionView, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), transactionErrors.notFound(input.id));

    const locale = await deps.locale();

    if (existing.status === TransactionStatus.enum.effective) return ok(addLocalizedLabels(existing, locale));

    const confirmed = yield* okOr(await deps.transactions.confirm(input.id), transactionErrors.notFound(input.id));
    return ok(addLocalizedLabels(confirmed, locale));
  });
