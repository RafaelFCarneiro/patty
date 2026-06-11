import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as R from 'ramda';
import { PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis, ResponsiveContainer, LineChart, Line, Legend, CartesianGrid } from 'recharts';
import { fetchExpensesByCategory, fetchIncomeByCategory, fetchMonthlyBalance } from '@/api/reports';
import { MonthPicker } from '@/components/layout/MonthPicker';
import { PageHeader } from '@/components/ui/PageHeader';
import { useMonth } from '@/hooks/useMonth';
import { formatBRL, pieColor, MONTH_NAMES } from '@/lib/utils';

const MONTH_ABBR = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
type ReportType = 'expenses-cat' | 'income-cat' | 'monthly';

export const Reports = () => {
  const { month, year, prev, next } = useMonth();
  const [reportType, setReportType] = useState<ReportType>('expenses-cat');
  const [view, setView] = useState<'pie' | 'bar' | 'line'>('pie');

  const { data: expByCat = [] } = useQuery({ queryKey: ['reports-exp-cat', month, year], queryFn: () => fetchExpensesByCategory(month, year) });
  const { data: incByCat = [] } = useQuery({ queryKey: ['reports-inc-cat', month, year], queryFn: () => fetchIncomeByCategory(month, year) });
  const { data: monthlyBalance = [] } = useQuery({ queryKey: ['reports-monthly', year], queryFn: () => fetchMonthlyBalance(year) });

  const catData = reportType === 'expenses-cat' ? expByCat : incByCat;
  const total = R.sum(catData.map(d => d.total));

  const pieData = catData.map((d, i) => ({ name: d.category.name, value: d.total, color: d.category.color || pieColor(i) }));
  const monthData = monthlyBalance.map(m => ({ month: MONTH_ABBR[m.month - 1], income: m.income, expenses: m.expenses, balance: m.balance }));

  const reportOptions: { value: ReportType; label: string }[] = [
    { value: 'expenses-cat', label: 'Despesas por categoria' },
    { value: 'income-cat', label: 'Receitas por categoria' },
    { value: 'monthly', label: 'Balanço mensal' },
  ];

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    return <div className="bg-surface border border-border rounded-lg p-3 text-sm"><p className="text-white font-semibold">{payload[0].name}</p><p className="text-muted">{formatBRL(payload[0].value)}</p></div>;
  };

  return (
    <div className="p-6 space-y-5">
      <PageHeader title="Relatórios">
        <div className="flex gap-1 bg-surface-2 rounded-lg p-1">
          {['pie','bar','line'].map(v => <button key={v} onClick={() => setView(v as any)} className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${view === v ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}>{v === 'pie' ? '◕' : v === 'bar' ? '▮▮' : '↗'}</button>)}
        </div>
        <select value={reportType} onChange={e => setReportType(e.target.value as ReportType)} className="bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary">
          {reportOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {reportType !== 'monthly' && <MonthPicker month={month} year={year} onPrev={prev} onNext={next} />}
      </PageHeader>

      <div className="bg-surface border border-border rounded-xl p-6">
        {reportType === 'monthly' ? (
          <ResponsiveContainer width="100%" height={380}>
            {view === 'line' ? (
              <LineChart data={monthData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="month" tick={{ fill: '#6b7280', fontSize: 12 }} />
                <YAxis tickFormatter={(v: any) => formatBRL(v)} tick={{ fill: '#6b7280', fontSize: 11 }} width={90} />
                <Tooltip formatter={(v: any) => formatBRL(v)} contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }} />
                <Legend />
                <Line type="monotone" dataKey="income" stroke="#22c55e" strokeWidth={2} name="Receitas" dot={false} />
                <Line type="monotone" dataKey="expenses" stroke="#ef4444" strokeWidth={2} name="Despesas" dot={false} />
                <Line type="monotone" dataKey="balance" stroke="#7c3aed" strokeWidth={2} name="Balanço" dot={false} />
              </LineChart>
            ) : (
              <BarChart data={monthData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="month" tick={{ fill: '#6b7280', fontSize: 12 }} />
                <YAxis tickFormatter={(v: any) => formatBRL(v)} tick={{ fill: '#6b7280', fontSize: 11 }} width={90} />
                <Tooltip formatter={(v: any) => formatBRL(v)} contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }} />
                <Legend />
                <Bar dataKey="income" fill="#22c55e" name="Receitas" radius={[4,4,0,0]} />
                <Bar dataKey="expenses" fill="#ef4444" name="Despesas" radius={[4,4,0,0]} />
              </BarChart>
            )}
          </ResponsiveContainer>
        ) : (
          <div className="grid grid-cols-2 gap-6">
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="50%" innerRadius={70} outerRadius={110} dataKey="value">
                  {pieData.map((e, i) => <Cell key={i} fill={e.color} />)}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="space-y-2 overflow-y-auto max-h-[300px]">
              <h3 className="font-semibold text-white mb-3">{reportOptions.find(o => o.value === reportType)?.label}</h3>
              {catData.map((d, i) => (
                <div key={d.category._id} className="flex items-center gap-3 py-1.5 border-b border-border last:border-0">
                  <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: d.category.color || pieColor(i) }} />
                  <span className="text-white text-sm flex-1">{d.category.name}</span>
                  <span className="text-muted text-xs">{total > 0 ? `${((d.total / total) * 100).toFixed(1)}%` : '0%'}</span>
                  <span className="text-white font-semibold text-sm">{formatBRL(d.total)}</span>
                </div>
              ))}
              {catData.length === 0 && <p className="text-muted text-sm text-center py-8">Sem dados para este período</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
