import * as R from 'ramda';
import client from './client';

export interface DashboardSummary {
  balance: number;
  income: number;
  expenses: number;
  pendingExpenses: number;
  pendingIncome: number;
  creditCardTotal: number;
}

export interface CalendarDay { date: string; income: number; expenses: number; }

export const fetchSummary = (month: number, year: number) =>
  client.get<DashboardSummary>('/dashboard/summary', { params: { month, year } }).then(R.prop('data'));

export const fetchCalendar = (month: number, year: number) =>
  client.get<CalendarDay[]>('/dashboard/calendar', { params: { month, year } }).then(R.prop('data'));
