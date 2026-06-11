import * as R from 'ramda';
import client from './client';

export interface Goal {
  _id: string;
  name: string;
  targetAmount: number;
  currentAmount: number;
  targetDate: string | null;
  status: 'active' | 'completed';
  icon: string;
  color: string;
}

const base = '/goals';
export const fetchGoals = (status?: string) => client.get<Goal[]>(base, { params: status ? { status } : {} }).then(R.prop('data'));
export const createGoal = (data: Partial<Goal>) => client.post<Goal>(base, data).then(R.prop('data'));
export const updateGoal = (id: string, data: Partial<Goal>) => client.patch<Goal>(`${base}/${id}`, data).then(R.prop('data'));
export const deleteGoal = (id: string) => client.delete(`${base}/${id}`).then(R.prop('data'));
