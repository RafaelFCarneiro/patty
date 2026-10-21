import {
  CREDIT_CARD_ENTITY_TAG,
  CreditCardEntitySchema,
  type AddCardPurchase,
  type CreateCreditCard,
  type CreditCardEntity,
  type ImportCardStatement,
  type UpdateCardTransaction,
  type UpdateCreditCard,
} from '../models/credit-card.js';
import * as persistence from '../logic/persistence.js';
import type { CreditCardRow } from '../wire/db/credit-cards.js';
import type * as wireIn from '../wire/in/credit-cards.js';

export const wireInToModel = (input: wireIn.CreateCreditCard): CreateCreditCard => input;

export const updateWireInToModel = (input: wireIn.UpdateCreditCard): UpdateCreditCard => input;

export const addCardPurchaseWireInToModel = (input: wireIn.AddCardPurchase): AddCardPurchase => input;

export const updateCardTransactionWireInToModel = (input: wireIn.UpdateCardTransaction): UpdateCardTransaction => input;

export const importCardStatementWireInToModel = (input: wireIn.ImportCardStatement): ImportCardStatement => input;

/** Read variant carrying `version` — for `deleteCreditCard`, which needs it to build a
 *  version-guarded `Persistable`. */
export const dbToEntity = (row: CreditCardRow): CreditCardEntity =>
  CreditCardEntitySchema.parse({
    id: row.id,
    name: row.name,
    currency: row.currency,
    closingDay: row.closingDay,
    dueDay: row.dueDay,
    limit: row.limitAmount ?? undefined,
    accountId: row.accountId,
    paymentAccountId: row.paymentAccountId ?? undefined,
    version: row.version,
  });

/** Entity → row for the versioned unit of work. */
export const modelToDb = (entity: CreditCardEntity): CreditCardRow => ({
  id: entity.id,
  name: entity.name,
  currency: entity.currency,
  closingDay: entity.closingDay,
  dueDay: entity.dueDay,
  limitAmount: entity.limit ?? null,
  accountId: entity.accountId,
  paymentAccountId: entity.paymentAccountId ?? null,
  version: entity.version,
});

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(CREDIT_CARD_ENTITY_TAG, modelToDb);
