export class UpdateTransactionDto {
  description?: string;
  amount?: number;
  type?: string;
  date?: Date;
  categoryId?: string | null;
  accountId?: string | null;
  creditCardId?: string | null;
  tags?: string[];
  status?: string;
  notes?: string;
  recurrence?: string;
}
