import * as R from 'ramda';
import client from './client';
import type { Category } from './categories';

export interface Budget {
  _id: string;
  categoryId: Category;
  month: number;
  year: number;
  plannedAmount: number;
}

const base = '/budgets';
export const fetchBudgets = (month?: number, year?: number) => client.get<Budget[]>(base, { params: { month, year } }).then(R.prop('data'));
export const createBudget = (data: Partial<Budget>) => client.post<Budget>(base, data).then(R.prop('data'));
export const updateBudget = (id: string, data: Partial<Budget>) => client.patch<Budget>(`${base}/${id}`, data).then(R.prop('data'));
export const deleteBudget = (id: string) => client.delete(`${base}/${id}`).then(R.prop('data'));
