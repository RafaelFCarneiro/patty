import * as R from 'ramda';
import client from './client';

export interface CategoryReport { category: { _id: string; name: string; color: string }; total: number; }
export interface MonthlyBalance { month: number; year: number; income: number; expenses: number; balance: number; }
export interface Performance { income: number; expenses: number; savings: number; savingsRate: number; spendingRate: number; month: number; year: number; }

export const fetchExpensesByCategory = (month: number, year: number) =>
  client.get<CategoryReport[]>('/reports/expenses-by-category', { params: { month, year } }).then(R.prop('data'));

export const fetchIncomeByCategory = (month: number, year: number) =>
  client.get<CategoryReport[]>('/reports/income-by-category', { params: { month, year } }).then(R.prop('data'));

export const fetchMonthlyBalance = (year: number) =>
  client.get<MonthlyBalance[]>('/reports/monthly-balance', { params: { year } }).then(R.prop('data'));

export const fetchPerformance = (month: number, year: number) =>
  client.get<Performance>('/reports/performance', { params: { month, year } }).then(R.prop('data'));
