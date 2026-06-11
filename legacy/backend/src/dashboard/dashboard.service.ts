import { Injectable } from '@nestjs/common';
import * as R from 'ramda';
import { AccountsService } from '../accounts/accounts.service';
import { TransactionsService } from '../transactions/transactions.service';
import { CreditCardsService } from '../credit-cards/credit-cards.service';

const now = new Date();

@Injectable()
export class DashboardService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly transactions: TransactionsService,
    private readonly creditCards: CreditCardsService,
  ) {}

  summary = async (month: number, year: number) => {
    const m = Number(month) || now.getMonth() + 1;
    const y = Number(year) || now.getFullYear();

    const [balance, income, expenses, pendingExpenses, pendingIncome, cards] = await Promise.all([
      this.accounts.sumBalances(),
      this.transactions.sumByType('income', m, y),
      this.transactions.sumByType('expense', m, y),
      this.transactions.pendingSum('expense', m, y),
      this.transactions.pendingSum('income', m, y),
      this.creditCards.findAll(),
    ]);

    const creditCardTotal = R.sum(
      await Promise.all(cards.map((c: any) => this.creditCards.totalUsed(c._id.toString(), m, y)))
    );

    return { balance, income, expenses, pendingExpenses, pendingIncome, creditCardTotal };
  };

  calendar = async (month: number, year: number) => {
    const m = Number(month) || now.getMonth() + 1;
    const y = Number(year) || now.getFullYear();
    const byDate = await this.transactions.groupByDate(m, y);
    return Object.entries(byDate).map(([date, txs]) => ({
      date,
      income: R.sum(R.pluck('amount', (txs as any[]).filter((t) => t.type === 'income'))),
      expenses: R.sum(R.pluck('amount', (txs as any[]).filter((t) => t.type === 'expense'))),
    }));
  };
}
