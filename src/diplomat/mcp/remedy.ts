import { withRemedyHint, type AppError } from '../../common/errors.js';
import type { Remedy } from '../../models/remedy.js';
import { ToolName } from './tool-name.js';

/** The MCP tool that performs each domain operation a rejected call is told to use instead. */
const REMEDY_TOOL = {
  pay_bill: ToolName.enum.pay_bill,
  revert_bill_payment: ToolName.enum.revert_bill_payment,
  create_credit_card: ToolName.enum.create_credit_card,
  update_credit_card: ToolName.enum.update_credit_card,
  delete_credit_card: ToolName.enum.delete_credit_card,
  update_account_transaction: ToolName.enum.update_account_transaction,
  update_card_transaction: ToolName.enum.update_card_transaction,
  delete_account_transaction: ToolName.enum.delete_account_transaction,
  delete_card_transaction: ToolName.enum.delete_card_transaction,
} as const satisfies Record<Remedy, ToolName>;

export const remedyHint = (remedy: Remedy): string => `use ${REMEDY_TOOL[remedy]}`;

/** The error as an MCP reply shows it: a `remedy` becomes `hint: "use <tool>"`. */
export const withToolHint = (error: AppError) => withRemedyHint(error, remedyHint);
