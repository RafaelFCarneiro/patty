import * as R from 'ramda';
import client from './client';

export interface Category {
  _id: string;
  name: string;
  type: 'income' | 'expense';
  icon: string;
  color: string;
  parentId: string | null;
}

const base = '/categories';
export const fetchCategories = (type?: string) => client.get<Category[]>(base, { params: type ? { type } : {} }).then(R.prop('data'));
export const createCategory = (data: Partial<Category>) => client.post<Category>(base, data).then(R.prop('data'));
export const updateCategory = (id: string, data: Partial<Category>) => client.patch<Category>(`${base}/${id}`, data).then(R.prop('data'));
export const deleteCategory = (id: string) => client.delete(`${base}/${id}`).then(R.prop('data'));
