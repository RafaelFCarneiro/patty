import * as R from 'ramda';
import client from './client';
import type { Category } from './categories';
import type { Account } from './accounts';
import type { Tag } from './tags';

export interface Transaction {
  _id: string;
  description: string;
  amount: number;
  type: 'income' | 'expense';
  date: string;
  categoryId: Category | null;
  accountId: Account | null;
  creditCardId: string | null;
  tags: Tag[];
  status: 'paid' | 'pending';
  notes: string;
  recurrence: string;
}

export interface TxQuery { month?: number; year?: number; type?: string; accountId?: string; categoryId?: string; status?: string; }

const base = '/transactions';
export const fetchTransactions = (q: TxQuery) => client.get<Transaction[]>(base, { params: q }).then(R.prop('data'));
export const fetchTransaction = (id: string) => client.get<Transaction>(`${base}/${id}`).then(R.prop('data'));
export const createTransaction = (data: Partial<Transaction>) => client.post<Transaction>(base, data).then(R.prop('data'));
export const updateTransaction = (id: string, data: Partial<Transaction>) => client.patch<Transaction>(`${base}/${id}`, data).then(R.prop('data'));
export const deleteTransaction = (id: string) => client.delete(`${base}/${id}`).then(R.prop('data'));
