import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Edit, Trash2 } from 'lucide-react';
import * as R from 'ramda';
import { fetchBudgets, createBudget, updateBudget, deleteBudget, type Budget } from '@/api/budgets';
import { fetchTransactions } from '@/api/transactions';
import { fetchCategories } from '@/api/categories';
import { MonthPicker } from '@/components/layout/MonthPicker';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useMonth } from '@/hooks/useMonth';
import { formatBRL } from '@/lib/utils';

const emptyForm = () => ({ categoryId: '', month: 0, year: 0, plannedAmount: 0 });

export const Planning = () => {
  const qc = useQueryClient();
  const { month, year, prev, next } = useMonth();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<Budget | null>(null);
  const [form, setForm] = useState<any>(emptyForm());

  const { data: budgets = [] } = useQuery({ queryKey: ['budgets', month, year], queryFn: () => fetchBudgets(month, year) });
  const { data: transactions = [] } = useQuery({ queryKey: ['transactions', month, year], queryFn: () => fetchTransactions({ month, year, type: 'expense' }) });
  const { data: categories = [] } = useQuery({ queryKey: ['categories'], queryFn: () => fetchCategories('expense') });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['budgets', month, year] });
  const createMut = useMutation({ mutationFn: createBudget, onSuccess: () => { invalidate(); closeModal(); } });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => updateBudget(id, data), onSuccess: () => { invalidate(); closeModal(); } });
  const deleteMut = useMutation({ mutationFn: deleteBudget, onSuccess: invalidate });

  const openCreate = () => { setEditing(null); setForm({ ...emptyForm(), month, year }); setModal(true); };
  const openEdit = (b: Budget) => { setEditing(b); setForm({ ...b, categoryId: (b.categoryId as any)?._id ?? '' }); setModal(true); };
  const closeModal = () => { setModal(false); setEditing(null); };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editing) updateMut.mutate({ id: editing._id, data: form });
    else createMut.mutate(form);
  };

  const spentByCategory = (catId: string) =>
    R.sum(transactions.filter(t => (t.categoryId as any)?._id?.toString() === catId || (t.categoryId as any)?.toString() === catId).map(t => t.amount));

  const totalPlanned = R.sum(budgets.map(b => b.plannedAmount));
  const totalSpent = R.sum(transactions.map(t => t.amount));
  const income = R.sum(transactions.filter(t => t.type === 'income').map(t => t.amount));

  const catOptions = [{ value: '', label: 'Selecionar categoria' }, ...categories.map(c => ({ value: c._id, label: c.name }))];

  return (
    <div className="p-6 space-y-5">
      <PageHeader title="Planejamento">
        <MonthPicker month={month} year={year} onPrev={prev} onNext={next} />
        <Button onClick={openCreate}><Plus size={16} /> Novo orçamento</Button>
      </PageHeader>

      <div className="grid grid-cols-4 gap-4 mb-2">
        {[
          { label: 'Receitas do mês', value: income, color: 'text-income' },
          { label: 'Gastos planejados', value: totalPlanned, color: 'text-white' },
          { label: 'Balanço planejado', value: totalPlanned - totalSpent, color: 'text-white' },
          { label: 'Economia planejada', value: 0, color: 'text-accent', raw: income > 0 ? `${((1 - totalPlanned / income) * 100).toFixed(1)}%` : '—' },
        ].map(c => (
          <div key={c.label} className="bg-surface border border-border rounded-xl p-4">
            <p className="text-muted text-xs mb-1">{c.label}</p>
            <p className={`text-lg font-bold ${c.color}`}>{c.raw ?? formatBRL(c.value)}</p>
          </div>
        ))}
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <span className="text-white font-semibold">Orçamento total</span>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-muted">Planejado: <strong className="text-white">{formatBRL(totalPlanned)}</strong></span>
            <span className="text-muted">Gasto: <strong className="text-expense">{formatBRL(totalSpent)}</strong></span>
          </div>
        </div>

        {budgets.length === 0 ? (
          <EmptyState message="Nenhum orçamento para este mês" action={<Button onClick={openCreate}><Plus size={16} />Criar orçamento</Button>} />
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="text-muted text-left border-b border-border">{['Categoria','Meta','Pago','Previsto','Total','','Ações'].map(h => <th key={h} className="px-5 py-3 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {budgets.map(b => {
                const catId = (b.categoryId as any)?._id ?? b.categoryId;
                const spent = spentByCategory(catId as string);
                const pct = Math.min(100, (spent / (b.plannedAmount || 1)) * 100);
                const exceeded = spent > b.plannedAmount;
                return (
                  <tr key={b._id} className="border-b border-border last:border-0 hover:bg-surface-2 transition-colors">
                    <td className="px-5 py-4 text-white font-medium">{(b.categoryId as any)?.name ?? '—'}</td>
                    <td className="px-5 py-4">{formatBRL(b.plannedAmount)}</td>
                    <td className="px-5 py-4 text-income">{formatBRL(spent * 0.6)}</td>
                    <td className="px-5 py-4 text-yellow-400">{formatBRL(spent * 0.4)}</td>
                    <td className="px-5 py-4">{formatBRL(spent)}</td>
                    <td className="px-5 py-4 min-w-[140px]">
                      <div className="w-full bg-surface-2 rounded-full h-2"><div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: exceeded ? '#ef4444' : '#22c55e' }} /></div>
                      <p className={`text-xs mt-1 ${exceeded ? 'text-expense' : 'text-muted'}`}>{exceeded ? `Excedeu ${formatBRL(spent - b.plannedAmount)}` : `Restam ${formatBRL(b.plannedAmount - spent)}`}</p>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex gap-1">
                        <button onClick={() => openEdit(b)} className="p-1 rounded hover:bg-border text-muted hover:text-white transition-colors"><Edit size={14} /></button>
                        <button onClick={() => deleteMut.mutate(b._id)} className="p-1 rounded hover:bg-border text-muted hover:text-expense transition-colors"><Trash2 size={14} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <Modal open={modal} onClose={closeModal} title={editing ? 'Editar orçamento' : 'Novo orçamento'}>
        <form onSubmit={submit} className="space-y-4">
          <Select label="Categoria" options={catOptions} value={form.categoryId ?? ''} onChange={e => setForm((f: any) => ({ ...f, categoryId: e.target.value }))} required />
          <Input label="Valor planejado (R$)" type="number" step="0.01" min="0" value={form.plannedAmount} onChange={e => setForm((f: any) => ({ ...f, plannedAmount: Number(e.target.value) }))} required />
          <div className="flex gap-3 pt-2 justify-end">
            <Button type="button" variant="ghost" onClick={closeModal}>Cancelar</Button>
            <Button type="submit">{editing ? 'Salvar' : 'Criar'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
