import {
  CREDIT_CARD_ENTITY_TAG,
  CreditCardEntitySchema,
  type AddCardPurchase,
  type CreateCreditCard,
  type CreditCard,
  type CreditCardEntity,
  type ImportCardStatement,
  type UpdateCardTransaction,
} from '../models/creditCard.js';
import { INITIAL_VERSION, PersistOp, type FlowOutcome, type Persistable } from '../models/persistable.js';
import type { CreditCardRow } from '../wire/db/creditCards.js';
import type * as wireIn from '../wire/in/creditCards.js';

export const wireInToModel = (input: wireIn.CreateCreditCard): CreateCreditCard => input;

export const addCardPurchaseWireInToModel = (input: wireIn.AddCardPurchase): AddCardPurchase => input;

export const updateCardTransactionWireInToModel = (input: wireIn.UpdateCardTransaction): UpdateCardTransaction => input;

export const importCardStatementWireInToModel = (input: wireIn.ImportCardStatement): ImportCardStatement => input;

/** Read variant carrying `version` (ADR-021) — for `deleteCreditCard`, which needs it to build a
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

/** Entity → row for the versioned unit of work (ADR-021) — mirrors `adapters/accounts.ts`'s
 *  `modelToDb`. */
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

/** Adapts one credit-card `Persistable`'s `model` from domain shape to db-row shape (ADR-021),
 *  mirroring `adapters/accounts.ts`'s `persistableToDb` — called explicitly by the MCP/REST
 *  handler before the batch ever reaches `withUnitOfWork`. No-ops on a `Persistable` tagged for a
 *  different entity (`createCreditCard`'s batch also carries an `ACCOUNT_ENTITY_TAG` persistable
 *  for the internal liability account — `accountAdapters.outcomeToDb` shapes that one). Only
 *  `insert`/`delete` are reachable (no credit-card `update` flow yet). */
export const persistableToDb = (p: Persistable): Persistable => {
  if (p.entity !== CREDIT_CARD_ENTITY_TAG) return p;
  switch (p.op) {
    case PersistOp.enum.insert:
      return { ...p, model: modelToDb({ ...(p.model as CreditCard), version: INITIAL_VERSION }) };
    case PersistOp.enum.update:
      return { ...p, model: modelToDb(p.model as CreditCardEntity) };
    case PersistOp.enum.delete:
      return p;
    default: {
      const _exhaustive: never = p;
      throw new Error(`creditCardAdapters.persistableToDb: unhandled persistable op ${JSON.stringify(_exhaustive)}`);
    }
  }
};

/** Maps every `Persistable` in a flow's outcome through `persistableToDb` before `unitOfWork`. */
export const outcomeToDb = <T>(outcome: FlowOutcome<T>): FlowOutcome<T> => ({
  ...outcome,
  persist: outcome.persist.map(persistableToDb),
});
