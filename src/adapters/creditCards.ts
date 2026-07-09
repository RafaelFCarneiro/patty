import type { CreateCreditCard } from '../models/creditCard.js';
import type { AddCardPurchase } from '../models/transaction.js';
import type * as wireIn from '../wire/in/creditCards.js';

export const wireInToModel = (input: wireIn.CreateCreditCard): CreateCreditCard => input;

export const addCardPurchaseWireInToModel = (input: wireIn.AddCardPurchase): AddCardPurchase => input;
