import * as R from 'ramda';
import client from './client';

export interface Account {
  _id: string;
  name: string;
  type: string;
  balance: number;
  icon: string;
  color: string;
  includeInTotal: boolean;
  showOnDashboard: boolean;
}

const base = '/accounts';
export const fetchAccounts = () => client.get<Account[]>(base).then(R.prop('data'));
export const fetchAccount = (id: string) => client.get<Account>(`${base}/${id}`).then(R.prop('data'));
export const createAccount = (data: Partial<Account>) => client.post<Account>(base, data).then(R.prop('data'));
export const updateAccount = (id: string, data: Partial<Account>) => client.patch<Account>(`${base}/${id}`, data).then(R.prop('data'));
export const deleteAccount = (id: string) => client.delete(`${base}/${id}`).then(R.prop('data'));
