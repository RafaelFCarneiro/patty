import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from 'recharts';
import { fetchPerformance } from '@/api/reports';
import { PageHeader } from '@/components/ui/PageHeader';
import { MonthPicker } from '@/components/layout/MonthPicker';
import { useMonth } from '@/hooks/useMonth';
import { formatBRL } from '@/lib/utils';

export const Performance = () => {
  const { month, year, prev, next } = useMonth();
  const { data: perf } = useQuery({ queryKey: ['performance', month, year], queryFn: () => fetchPerformance(month, year) });

  const barData = perf ? [
    { name: 'Receitas', value: perf.income, fill: '#22c55e' },
    { name: 'Despesas', value: perf.expenses, fill: '#ef4444' },
    { name: 'Economia', value: perf.savings, fill: '#7c3aed' },
  ] : [];

  return (
    <div className="p-6 space-y-5">
      <PageHeader title="Meu Desempenho">
        <MonthPicker month={month} year={year} onPrev={prev} onNext={next} />
      </PageHeader>
      <p className="text-muted text-sm -mt-3">Baseado em seus gastos e receitas do mês selecionado.</p>

      <div className="grid grid-cols-3 gap-4">
        <div className="bg-surface border border-border rounded-xl p-5 text-center">
          <p className="text-muted text-sm mb-2">Taxa de economia</p>
          <p className="text-4xl font-bold text-primary">{perf?.savingsRate?.toFixed(1) ?? '0.0'}%</p>
          <p className="text-muted text-xs mt-2">Você gastou {perf?.spendingRate?.toFixed(1) ?? 0}% dos seus ganhos</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-5 text-center">
          <p className="text-muted text-sm mb-2">Total economizado</p>
          <p className="text-3xl font-bold text-income">{formatBRL(perf?.savings ?? 0)}</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-5 text-center">
          <p className="text-muted text-sm mb-2">Saldo final</p>
          <p className="text-3xl font-bold text-white">{formatBRL((perf?.income ?? 0) - (perf?.expenses ?? 0))}</p>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-5">
        <h3 className="font-semibold text-white mb-4">Receitas vs Despesas vs Economia</h3>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={barData} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" horizontal={false} />
            <XAxis type="number" tickFormatter={(v: any) => formatBRL(v)} tick={{ fill: '#6b7280', fontSize: 11 }} />
            <YAxis type="category" dataKey="name" tick={{ fill: '#6b7280', fontSize: 12 }} width={80} />
            <Tooltip formatter={(v: any) => formatBRL(v)} contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }} />
            <Bar dataKey="value" radius={[0,4,4,0]}>
              {barData.map((d, i) => (
                <rect key={i} fill={d.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
