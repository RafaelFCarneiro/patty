import { useQuery } from '@tanstack/react-query';
import * as R from 'ramda';
import { Wallet, TrendingUp, TrendingDown, CreditCard, AlertCircle, CheckCircle } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Legend } from 'recharts';
import { fetchSummary, fetchCalendar } from '@/api/dashboard';
import { fetchExpensesByCategory, fetchIncomeByCategory } from '@/api/reports';
import { fetchBudgets } from '@/api/budgets';
import { fetchCreditCards } from '@/api/credit-cards';
import { SummaryCard } from '@/components/ui/SummaryCard';
import { MonthPicker } from '@/components/layout/MonthPicker';
import { useMonth } from '@/hooks/useMonth';
import { formatBRL, pieColor, MONTH_NAMES } from '@/lib/utils';

const MONTH_ABBR = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

export const Dashboard = () => {
  const { month, year, prev, next } = useMonth();

  const { data: summary } = useQuery({ queryKey: ['dashboard-summary', month, year], queryFn: () => fetchSummary(month, year) });
  const { data: expByCat } = useQuery({ queryKey: ['reports-exp-cat', month, year], queryFn: () => fetchExpensesByCategory(month, year) });
  const { data: incByCat } = useQuery({ queryKey: ['reports-inc-cat', month, year], queryFn: () => fetchIncomeByCategory(month, year) });
  const { data: budgets } = useQuery({ queryKey: ['budgets', month, year], queryFn: () => fetchBudgets(month, year) });
  const { data: cards } = useQuery({ queryKey: ['credit-cards'], queryFn: fetchCreditCards });
  const { data: calendar } = useQuery({ queryKey: ['calendar', month, year], queryFn: () => fetchCalendar(month, year) });

  const expPieData = (expByCat ?? []).map((e, i) => ({ name: e.category.name, value: e.total, color: e.category.color || pieColor(i) }));
  const incPieData = (incByCat ?? []).map((e, i) => ({ name: e.category.name, value: e.total, color: e.category.color || pieColor(i) }));
  const totalBudget = R.sum((budgets ?? []).map(b => b.plannedAmount));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <MonthPicker month={month} year={year} onPrev={prev} onNext={next} />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        <SummaryCard title="Saldo atual" value={summary?.balance ?? 0} icon={<Wallet size={22} className="text-white" />} iconBg="bg-indigo-600" />
        <SummaryCard title="Receitas" value={summary?.income ?? 0} icon={<TrendingUp size={22} className="text-white" />} iconBg="bg-income" valueColor="text-income" />
        <SummaryCard title="Despesas" value={summary?.expenses ?? 0} icon={<TrendingDown size={22} className="text-white" />} iconBg="bg-expense" valueColor="text-expense" />
        <SummaryCard title="Cartão de crédito" value={summary?.creditCardTotal ?? 0} icon={<CreditCard size={22} className="text-white" />} iconBg="bg-accent" />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-2 gap-4">
        {/* Expenses by category */}
        <div className="bg-surface rounded-xl p-5 border border-border">
          <h3 className="text-sm font-semibold text-white mb-4">Despesas por categoria</h3>
          {expPieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={expPieData} cx="40%" cy="50%" innerRadius={60} outerRadius={90} dataKey="value">
                  {expPieData.map((e, i) => <Cell key={i} fill={e.color} />)}
                </Pie>
                <Tooltip formatter={(v: any) => formatBRL(v)} contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }} />
                <Legend formatter={(v) => <span className="text-xs text-muted">{v}</span>} />
              </PieChart>
            </ResponsiveContainer>
          ) : <p className="text-muted text-sm text-center py-8">Sem dados</p>}
        </div>

        {/* Income by category */}
        <div className="bg-surface rounded-xl p-5 border border-border">
          <h3 className="text-sm font-semibold text-white mb-4">Receitas por categoria</h3>
          {incPieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={incPieData} cx="40%" cy="50%" innerRadius={60} outerRadius={90} dataKey="value">
                  {incPieData.map((e, i) => <Cell key={i} fill={e.color} />)}
                </Pie>
                <Tooltip formatter={(v: any) => formatBRL(v)} contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }} />
                <Legend formatter={(v) => <span className="text-xs text-muted">{v}</span>} />
              </PieChart>
            </ResponsiveContainer>
          ) : <p className="text-muted text-sm text-center py-8">Sem dados</p>}
        </div>
      </div>

      {/* Bottom Row */}
      <div className="grid grid-cols-3 gap-4">
        {/* Monthly balance */}
        <div className="bg-surface rounded-xl p-5 border border-border">
          <h3 className="text-sm font-semibold text-white mb-4">Balanço mensal</h3>
          <div className="space-y-3">
            <div className="flex justify-between"><span className="text-muted text-sm">Receitas</span><span className="text-income font-semibold text-sm">{formatBRL(summary?.income ?? 0)}</span></div>
            <div className="flex justify-between"><span className="text-muted text-sm">Despesas</span><span className="text-expense font-semibold text-sm">{formatBRL(summary?.expenses ?? 0)}</span></div>
            <div className="border-t border-border pt-2 flex justify-between"><span className="text-white text-sm font-semibold">Balanço</span><span className="text-white font-bold text-sm">{formatBRL((summary?.income ?? 0) - (summary?.expenses ?? 0))}</span></div>
          </div>
        </div>

        {/* Pending */}
        <div className="bg-surface rounded-xl p-5 border border-border">
          <h3 className="text-sm font-semibold text-white mb-4">Pendências</h3>
          <div className="space-y-3">
            <div className="flex items-center gap-2"><AlertCircle size={16} className="text-expense" /><div><p className="text-xs text-muted">Despesas pendentes</p><p className="text-expense font-semibold text-sm">{formatBRL(summary?.pendingExpenses ?? 0)}</p></div></div>
            <div className="flex items-center gap-2"><CheckCircle size={16} className="text-income" /><div><p className="text-xs text-muted">Receitas pendentes</p><p className="text-income font-semibold text-sm">{formatBRL(summary?.pendingIncome ?? 0)}</p></div></div>
          </div>
        </div>

        {/* Budget summary */}
        <div className="bg-surface rounded-xl p-5 border border-border">
          <h3 className="text-sm font-semibold text-white mb-4">Planejamento</h3>
          {budgets && budgets.length > 0 ? (
            <div className="space-y-2">
              <div className="flex justify-between text-sm"><span className="text-muted">Orçamento total</span><span className="text-white font-semibold">{formatBRL(totalBudget)}</span></div>
              <div className="flex justify-between text-sm"><span className="text-muted">Gasto até agora</span><span className="text-expense font-semibold">{formatBRL(summary?.expenses ?? 0)}</span></div>
              <div className="w-full bg-surface-2 rounded-full h-2 mt-2">
                <div className="bg-primary h-2 rounded-full transition-all" style={{ width: `${Math.min(100, ((summary?.expenses ?? 0) / (totalBudget || 1)) * 100)}%` }} />
              </div>
            </div>
          ) : <p className="text-muted text-sm">Nenhum orçamento criado</p>}
        </div>
      </div>
    </div>
  );
};
