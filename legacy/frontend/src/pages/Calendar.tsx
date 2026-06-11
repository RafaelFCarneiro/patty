import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchCalendar } from '@/api/dashboard';
import { fetchTransactions } from '@/api/transactions';
import { PageHeader } from '@/components/ui/PageHeader';
import { useMonth } from '@/hooks/useMonth';
import { formatBRL, MONTH_NAMES } from '@/lib/utils';

const DAY_NAMES = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

export const Calendar = () => {
  const { month, year, prev, next } = useMonth();
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [pendingOnly, setPendingOnly] = useState(false);

  const { data: calData = [] } = useQuery({ queryKey: ['calendar', month, year], queryFn: () => fetchCalendar(month, year) });
  const { data: txs = [] } = useQuery({ queryKey: ['transactions', month, year], queryFn: () => fetchTransactions({ month, year }) });

  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  const calMap = new Map(calData.map(d => [d.date, d]));
  const txByDay = selectedDay ? txs.filter(t => t.date.slice(0, 10) === selectedDay && (!pendingOnly || t.status === 'pending')) : [];

  const cells: (number | null)[] = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

  const fmt = (day: number) => `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;

  return (
    <div className="p-6 space-y-5">
      <PageHeader title="Calendário">
        <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
          <input type="checkbox" checked={pendingOnly} onChange={e => setPendingOnly(e.target.checked)} className="accent-primary" />
          Somente pendentes
        </label>
      </PageHeader>

      <div className="grid grid-cols-5 gap-4">
        <div className="col-span-3 bg-surface border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <button onClick={prev} className="p-1 rounded hover:bg-surface-2 text-muted hover:text-white"><ChevronLeft size={18} /></button>
            <h2 className="font-semibold text-white">{MONTH_NAMES[month - 1]} {year}</h2>
            <button onClick={next} className="p-1 rounded hover:bg-surface-2 text-muted hover:text-white"><ChevronRight size={18} /></button>
          </div>
          <div className="grid grid-cols-7 gap-1 mb-2">
            {DAY_NAMES.map(d => <div key={d} className="text-center text-xs text-muted py-1 font-medium">{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((day, i) => {
              if (!day) return <div key={i} />;
              const key = fmt(day);
              const data = calMap.get(key);
              const isToday = key === new Date().toISOString().slice(0, 10);
              const isSelected = key === selectedDay;
              return (
                <div
                  key={key}
                  onClick={() => setSelectedDay(isSelected ? null : key)}
                  className={`min-h-[64px] rounded-lg p-1.5 cursor-pointer border transition-all ${isSelected ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-surface-2'}`}
                >
                  <p className={`text-xs font-semibold mb-1 ${isToday ? 'text-primary' : 'text-white'}`}>{day}</p>
                  {data?.income ? <p className="text-[10px] text-income truncate">{formatBRL(data.income)}</p> : null}
                  {data?.expenses ? <p className="text-[10px] text-expense truncate">{formatBRL(data.expenses)}</p> : null}
                </div>
              );
            })}
          </div>
        </div>

        <div className="col-span-2 bg-surface border border-border rounded-xl p-5">
          <h3 className="font-semibold text-white mb-4">
            {selectedDay ? `Detalhes — ${new Date(selectedDay + 'T12:00:00').toLocaleDateString('pt-BR')}` : 'Detalhes'}
          </h3>
          {!selectedDay ? (
            <p className="text-muted text-sm">Clique em um dia para ver os detalhes.</p>
          ) : txByDay.length === 0 ? (
            <p className="text-muted text-sm">Nenhuma transação neste dia.</p>
          ) : (
            <div className="space-y-2">
              {txByDay.map(t => (
                <div key={t._id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div><p className="text-white text-sm">{t.description}</p><p className="text-muted text-xs">{(t.categoryId as any)?.name ?? 'Sem categoria'}</p></div>
                  <p className={`font-semibold text-sm ${t.type === 'income' ? 'text-income' : 'text-expense'}`}>{t.type === 'income' ? '+' : '-'}{formatBRL(t.amount)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
