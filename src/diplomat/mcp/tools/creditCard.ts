import { ToolName } from '../../../models/tool.js';
import { z } from 'zod';
import { getBill, payBill, revertBillPayment } from '../../../controllers/creditCard/bill.js';
import {
  createCreditCard,
  deleteCreditCard,
  listCreditCards,
  updateCreditCard,
} from '../../../controllers/creditCard/creditCard.js';
import {
  addCardPurchase,
  deleteCardTransaction,
  importCardStatement,
  updateCardTransaction,
} from '../../../controllers/creditCard/transaction.js';
import { BillQuerySchema, PayBillSchema } from '../../../models/bill.js';
import { DeleteTransactionSchema, TransactionSource } from '../../../models/transaction.js';
import {
  AddCardPurchaseSchema,
  CreateCreditCardSchema,
  ImportCardStatementSchema,
  UpdateCardTransactionSchema,
  UpdateCreditCardSchema,
} from '../../../wire/in/creditCards.js';
import * as accountAdapters from '../../../adapters/accounts.js';
import * as billAdapters from '../../../adapters/bills.js';
import * as creditCardAdapters from '../../../adapters/creditCards.js';
import {
  addCardPurchaseWireInToModel,
  importCardStatementWireInToModel,
  updateCardTransactionWireInToModel,
} from '../../../adapters/creditCards.js';
import {
  bulkResultToWireOut,
  createResultToWireOut,
  deleteResultToWireOut,
  outcomeToDb,
} from '../../../adapters/transactions.js';
import { buildBulkResult } from '../../../controllers/transaction/bulk.js';
import { defineTool } from '../definition.js';
import { fromResult, json } from '../respond.js';
import { STATEMENT_IMPORT_RESULT_DESCRIPTION } from '../shared.js';
import { MUTATING, READ_ONLY } from '../annotations.js';

const importCardStatementDescription =
  'Import a credit-card statement (pasted text, CSV lines) — every item is a purchase on the ONE ' +
  "card named at the top level, joining each item's cycle bill (fatura). Single-source: the " +
  "credit-card aggregate's bulk entry point (ADR-017) — use import_account_statement instead for a " +
  `bank/wallet statement. ${STATEMENT_IMPORT_RESULT_DESCRIPTION}`;

const importCardStatementTool = defineTool({
  name: ToolName.enum.import_card_statement,
  config: {
    annotations: MUTATING,
    title: 'Import a credit-card statement',
    description: importCardStatementDescription,
    inputSchema: ImportCardStatementSchema.shape,
  },
  // Orchestration (plan → run each item → bulk result) that belongs in a controller; kept as one named step here.
  handle: async (args, { deps, runEffectsSequence }) => {
    const plan = await importCardStatement(deps, importCardStatementWireInToModel(args), TransactionSource.enum.import);
    const outcomes = await runEffectsSequence(
      plan.lines,
      (line) => () => plan.flowFor(line)().map(billAdapters.outcomeToDb).map(outcomeToDb),
    );
    return json(bulkResultToWireOut(buildBulkResult(outcomes, plan.lines)));
  },
});

const addCardPurchaseDescription =
  "Record a credit-card purchase, joining the cycle bill (fatura) — the credit-card aggregate's " +
  'purchase entry point (ADR-016). Resolves the card and category by ' +
  'name; when category is omitted, classifies via learned merchant→category associations and returns ' +
  'method + confidence (confirm with the user when confidence < 0.6). Idempotent automatically — a ' +
  'repeat call with the same card/description/date/amount is deduped; pass discriminator to record a ' +
  'genuinely separate transaction that would otherwise look identical. Currency always comes from the ' +
  "card (a card's currency is fixed at creation) — the currency field is accepted for schema symmetry " +
  'with add_account_expense/add_account_income but has no effect here.';

const addCardPurchaseTool = defineTool({
  name: ToolName.enum.add_card_purchase,
  config: {
    annotations: MUTATING,
    title: 'Add credit-card purchase',
    description: addCardPurchaseDescription,
    inputSchema: AddCardPurchaseSchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const model = addCardPurchaseWireInToModel(args);
    const flow = () =>
      addCardPurchase(deps, model, TransactionSource.enum.mcp).map(billAdapters.outcomeToDb).map(outcomeToDb);
    return fromResult((await runEffects(flow)).map(createResultToWireOut));
  },
});

const createCreditCardDescription =
  'Create a credit card with its internal liability account (ADR-010). closingDay: day the fatura ' +
  "closes (transactions after it go to next month's bill). dueDay: payment due day. Currency " +
  'defaults to USD. The card auto-creates an internal credit account that tracks outstanding debt.';

const createCreditCardTool = defineTool({
  name: ToolName.enum.create_credit_card,
  config: {
    annotations: MUTATING,
    title: 'Create credit card',
    description: createCreditCardDescription,
    inputSchema: CreateCreditCardSchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () =>
      createCreditCard(deps, args).map(accountAdapters.outcomeToDb).map(creditCardAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const listCreditCardsTool = defineTool({
  name: ToolName.enum.list_credit_cards,
  config: {
    annotations: READ_ONLY,
    title: 'List credit cards',
    description: 'List all credit cards.',
    inputSchema: {},
  },
  handle: async (_args, { deps }) => {
    return json(await listCreditCards(deps));
  },
});

const updateCreditCardDescription =
  "Update a credit card. name identifies the card; newName renames it — the card's internal account " +
  '(named "Card: {name}", ADR-010) is renamed in the same atomic write. limit/closingDay/dueDay are plain ' +
  'field updates (a closingDay/dueDay change only applies to future bill cycles; existing bills keep their ' +
  'own computed dates). paymentAccount is resolved and validated exactly like create_credit_card/pay_bill: ' +
  'rejected if it is a credit account or its currency does not match the card.';

const updateCreditCardTool = defineTool({
  name: ToolName.enum.update_credit_card,
  config: {
    annotations: MUTATING,
    title: 'Update credit card',
    description: updateCreditCardDescription,
    inputSchema: UpdateCreditCardSchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () =>
      updateCreditCard(deps, creditCardAdapters.updateWireInToModel(args))
        .map(accountAdapters.outcomeToDb)
        .map(creditCardAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const deleteCreditCardDescription =
  'Hard delete a credit card and everything associated: internal credit account, all purchases, ' +
  'bill payments, and bills. Without confirm:true it is a DRY RUN returning what would be deleted — ' +
  'show it to the user and call again with confirm: true. Irreversible.';

const deleteCreditCardTool = defineTool({
  name: ToolName.enum.delete_credit_card,
  config: {
    annotations: MUTATING,
    title: 'Delete credit card',
    description: deleteCreditCardDescription,
    inputSchema: {
      card: z.string().min(1).describe('Card name'),
      confirm: z.boolean().default(false).describe('Must be true to actually delete'),
    },
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () =>
      deleteCreditCard(deps, args)
        .map(creditCardAdapters.outcomeToDb)
        .map(accountAdapters.outcomeToDb)
        .map(billAdapters.outcomeToDb)
        .map(outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const getBillTool = defineTool({
  name: ToolName.enum.get_bill,
  config: {
    annotations: READ_ONLY,
    title: 'Get credit card bill (fatura)',
    description:
      'Get a card bill for a month: status (open/closed/paid), close/due dates, total, and its transactions.',
    inputSchema: BillQuerySchema.shape,
  },
  handle: async (args, { deps }) => {
    return fromResult(await getBill(deps, args));
  },
});

const payBillDescription =
  'Pay a credit card bill. Creates a canonical transfer (payer account → card internal account) ' +
  'for the full bill total, then marks the bill paid. Idempotent — re-calling on a paid bill is a no-op. ' +
  'Paying account resolution: explicit `account` → card default `paymentAccount` → error. ' +
  'Optional `paymentDate` (defaults to today) records when the payment occurred; it must not be in the ' +
  'future — the payment transfer is always effective and dated on/before today.';

const payBillTool = defineTool({
  name: ToolName.enum.pay_bill,
  config: {
    annotations: MUTATING,
    title: 'Pay credit card bill',
    description: payBillDescription,
    inputSchema: PayBillSchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () =>
      payBill(deps, { ...args, source: TransactionSource.enum.mcp })
        .map(billAdapters.outcomeToDb)
        .map(outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const revertBillPaymentDescription =
  'Undo a bill payment: deletes the payment transfer and flips the bill back from paid to closed. ' +
  'Idempotent — calling on a bill that is not paid is a no-op that returns it unchanged.';

const revertBillPaymentTool = defineTool({
  name: ToolName.enum.revert_bill_payment,
  config: {
    annotations: MUTATING,
    title: 'Revert credit card bill payment',
    description: revertBillPaymentDescription,
    inputSchema: BillQuerySchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => revertBillPayment(deps, args).map(billAdapters.outcomeToDb).map(outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const updateCardTransactionDescription =
  "Update a credit-card transaction by id (from search_transactions) — the credit-card aggregate's " +
  'update entry point (ADR-017/ADR-020). Owns transactions that involve a credit account: card ' +
  'purchases and the bill-payment transfer. cardId/billId (returned by search_transactions/ ' +
  'TransactionView) are reliable proxies for picking this tool — only these two cases ever have a ' +
  'credit-account leg — but TransactionView does not expose account types, and the authoritative ' +
  "check is the leg account type; if unsure (e.g. a transfer's toAccountId), call the tool and " +
  'follow the wrong-tool redirect. Calling this on a transaction with no credit-account leg is ' +
  `rejected with a validation error redirecting to ${ToolName.enum.update_account_transaction}. Only ` +
  'provided fields change. Setting category is a user correction (confidence 1, strengthens the ' +
  'merchant→category association). account cannot be changed — a card purchase is always funded by ' +
  "the card's own internal liability account (ADR-010). billMonth+billYear reassigns to a different " +
  'bill cycle (both required together); rejected with a validation error pointing at ' +
  'revert_bill_payment if the current or target bill is paid. The bill-payment transfer itself ' +
  '(billId set, no cardId) cannot be edited at all — it is owned exclusively by pay_bill/' +
  'revert_bill_payment.';

const updateCardTransactionTool = defineTool({
  name: ToolName.enum.update_card_transaction,
  config: {
    annotations: MUTATING,
    title: 'Update credit-card transaction',
    description: updateCardTransactionDescription,
    inputSchema: UpdateCardTransactionSchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const model = updateCardTransactionWireInToModel(args);
    const flow = () => updateCardTransaction(deps, model).map(billAdapters.outcomeToDb).map(outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const deleteCardTransactionDescription =
  "Delete a credit-card transaction by id — the credit-card aggregate's delete entry point " +
  '(ADR-017/ADR-020). Owns transactions that involve a credit account (card purchases and the ' +
  'bill-payment transfer); calling this on a transaction with no credit-account leg is rejected with ' +
  `a validation error redirecting to ${ToolName.enum.delete_account_transaction}. Without confirm:true ` +
  'it is a DRY RUN returning what would be deleted — show it to the user and call again with ' +
  'confirm: true. Any transaction on a paid bill (including the bill-payment transfer itself) cannot ' +
  'be deleted this way — rejected with a validation error pointing at revert_bill_payment.';

const deleteCardTransactionTool = defineTool({
  name: ToolName.enum.delete_card_transaction,
  config: {
    annotations: MUTATING,
    title: 'Delete credit-card transaction',
    description: deleteCardTransactionDescription,
    inputSchema: DeleteTransactionSchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => deleteCardTransaction(deps, args).map(billAdapters.outcomeToDb).map(outcomeToDb);
    return fromResult((await runEffects(flow)).map(deleteResultToWireOut));
  },
});

export const creditCardTools = [
  importCardStatementTool,
  addCardPurchaseTool,
  createCreditCardTool,
  listCreditCardsTool,
  updateCreditCardTool,
  deleteCreditCardTool,
  getBillTool,
  payBillTool,
  revertBillPaymentTool,
  updateCardTransactionTool,
  deleteCardTransactionTool,
];
