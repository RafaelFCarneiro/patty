import { Injectable } from '@nestjs/common';
import * as R from 'ramda';
import { TransactionsService } from '../transactions/transactions.service';

const now = new Date();

@Injectable()
export class ReportsService {
  constructor(private readonly transactions: TransactionsService) {}

  expensesByCategory = (month: number, year: number) => {
    const m = Number(month) || now.getMonth() + 1;
    const y = Number(year) || now.getFullYear();
    return this.transactions.groupByCategory('expense', m, y);
  };

  incomeByCategory = (month: number, year: number) => {
    const m = Number(month) || now.getMonth() + 1;
    const y = Number(year) || now.getFullYear();
    return this.transactions.groupByCategory('income', m, y);
  };

  monthlyBalance = async (year: number) => {
    const y = Number(year) || now.getFullYear();
    const months = R.range(1, 13);
    return Promise.all(
      months.map(async (m) => {
        const [income, expenses] = await Promise.all([
          this.transactions.sumByType('income', m, y),
          this.transactions.sumByType('expense', m, y),
        ]);
        return { month: m, year: y, income, expenses, balance: income - expenses };
      }),
    );
  };

  performance = async (month: number, year: number) => {
    const m = Number(month) || now.getMonth() + 1;
    const y = Number(year) || now.getFullYear();
    const [income, expenses] = await Promise.all([
      this.transactions.sumByType('income', m, y),
      this.transactions.sumByType('expense', m, y),
    ]);
    const savings = income - expenses;
    const savingsRate = income > 0 ? (savings / income) * 100 : 0;
    const spendingRate = income > 0 ? (expenses / income) * 100 : 0;
    return { income, expenses, savings, savingsRate, spendingRate, month: m, year: y };
  };
}
