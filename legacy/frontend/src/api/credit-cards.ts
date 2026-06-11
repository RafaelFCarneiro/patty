import * as R from 'ramda';
import client from './client';

export interface CreditCard {
  _id: string;
  name: string;
  limit: number;
  closingDay: number;
  dueDay: number;
  color: string;
  icon: string;
}

export interface Bill {
  _id: string;
  creditCardId: string;
  month: number;
  year: number;
  status: 'open' | 'closed' | 'paid';
  paidAt: string | null;
  paidAmount: number;
}

const base = '/credit-cards';
export const fetchCreditCards = () => client.get<CreditCard[]>(base).then(R.prop('data'));
export const createCreditCard = (data: Partial<CreditCard>) => client.post<CreditCard>(base, data).then(R.prop('data'));
export const updateCreditCard = (id: string, data: Partial<CreditCard>) => client.patch<CreditCard>(`${base}/${id}`, data).then(R.prop('data'));
export const deleteCreditCard = (id: string) => client.delete(`${base}/${id}`).then(R.prop('data'));
export const fetchBills = (cardId: string) => client.get<Bill[]>(`${base}/${cardId}/bills`).then(R.prop('data'));
export const payBill = (billId: string, amount?: number) => client.post(`/credit-cards/bills/${billId}/pay`, { amount }).then(R.prop('data'));
