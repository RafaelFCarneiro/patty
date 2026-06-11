import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import * as R from 'ramda';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export const formatBRL = (value: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);

export const MONTH_NAMES = [
  'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro',
];

export const currentMonth = () => new Date().getMonth() + 1;
export const currentYear = () => new Date().getFullYear();

export const sumBy = (key: string) => R.pipe(R.pluck(key) as any, R.sum);

const PIE_COLORS = ['#7c3aed','#06b6d4','#22c55e','#f59e0b','#ef4444','#ec4899','#8b5cf6','#14b8a6','#f97316','#3b82f6'];
export const pieColor = (i: number) => PIE_COLORS[i % PIE_COLORS.length];
