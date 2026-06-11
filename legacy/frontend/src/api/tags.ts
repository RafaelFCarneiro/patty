import * as R from 'ramda';
import client from './client';

export interface Tag { _id: string; name: string; }

const base = '/tags';
export const fetchTags = () => client.get<Tag[]>(base).then(R.prop('data'));
export const createTag = (data: Partial<Tag>) => client.post<Tag>(base, data).then(R.prop('data'));
export const updateTag = (id: string, data: Partial<Tag>) => client.patch<Tag>(`${base}/${id}`, data).then(R.prop('data'));
export const deleteTag = (id: string) => client.delete(`${base}/${id}`).then(R.prop('data'));
