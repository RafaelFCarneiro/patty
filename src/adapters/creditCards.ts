import type { AddCardPurchase, CreateCreditCard, ImportCardStatement } from '../models/creditCard.js';
import type { UpdateTransaction } from '../models/transaction.js';
import type * as wireIn from '../wire/in/creditCards.js';

export const wireInToModel = (input: wireIn.CreateCreditCard): CreateCreditCard => input;

export const addCardPurchaseWireInToModel = (input: wireIn.AddCardPurchase): AddCardPurchase => input;

export const updateCardTransactionWireInToModel = (input: wireIn.UpdateCardTransaction): UpdateTransaction => input;

export const importCardStatementWireInToModel = (input: wireIn.ImportCardStatement): ImportCardStatement => input;
