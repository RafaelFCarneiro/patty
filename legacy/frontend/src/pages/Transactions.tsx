import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Edit, Trash2, CheckCircle2, Clock } from 'lucide-react';
import * as R from 'ramda';
import { fetchTransactions, createTransaction, updateTransaction, deleteTransaction, type Transaction } from '@/api/transactions';
import { fetchCategories } from '@/api/categories';
import { fetchAccounts } from '@/api/accounts';
import { SummaryCard } from '@/components/ui/SummaryCard';
import { MonthPicker } from '@/components/layout/MonthPicker';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useMonth } from '@/hooks/useMonth';
import { formatBRL } from '@/lib/utils';
import { Wallet, TrendingUp, TrendingDown } from 'lucide-react';

const emptyForm = () => ({
  description: '', amount: 0, type: 'expense', date: new Date().toISOString().slice(0, 10),
  categoryId: '', accountId: '', status: 'paid', notes: '', recurrence: 'none',
});

export const Transactions = () => {
  const qc = useQueryClient();
  const { month, year, prev, next } = useMonth();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [form, setForm] = useState<any>(emptyForm());
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');

  const { data: transactions = [] } = useQuery({ queryKey: ['transactions', month, year], queryFn: () => fetchTransactions({ month, year }) });
  const { data: categories = [] } = useQuery({ queryKey: ['categories'], queryFn: () => fetchCategories() });
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['transactions', month, year] });
  const createMut = useMutation({ mutationFn: createTransaction, onSuccess: () => { invalidate(); closeModal(); } });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => updateTransaction(id, data), onSuccess: () => { invalidate(); closeModal(); } });
  const deleteMut = useMutation({ mutationFn: deleteTransaction, onSuccess: invalidate });

  const openCreate = () => { setEditing(null); setForm(emptyForm()); setModal(true); };
  const openEdit = (t: Transaction) => { setEditing(t); setForm({ ...t, date: t.date.slice(0, 10), categoryId: (t.categoryId as any)?._id ?? '', accountId: (t.accountId as any)?._id ?? '' }); setModal(true); };
  const closeModal = () => { setModal(false); setEditing(null); };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editing) updateMut.mutate({ id: editing._id, data: form });
    else createMut.mutate(form);
  };

  const income = R.sum(transactions.filter(t => t.type === 'income').map(t => t.amount));
  const expenses = R.sum(transactions.filter(t => t.type === 'expense').map(t => t.amount));
  const balance = income - expenses;

  const filtered = transactions
    .filter(t => filter === 'all' || t.type === filter)
    .filter(t => !search || t.description.toLowerCase().includes(search.toLowerCase()));

  const catOptions = [{ value: '', label: 'Sem categoria' }, ...categories.map(c => ({ value: c._id, label: c.name }))];
  const accOptions = [{ value: '', label: 'Sem conta' }, ...accounts.map(a => ({ value: a._id, label: a.name }))];

  return (
    <div className="p-6 space-y-5">
      <PageHeader title="Transações">
        <div className="relative"><Search size={16} className="absolute left-3 top-2.5 text-muted" /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar..." className="bg-surface border border-border rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder:text-muted focus:outline-none focus:border-primary w-52" /></div>
        <MonthPicker month={month} year={year} onPrev={prev} onNext={next} />
        <Button onClick={openCreate}><Plus size={16} /> Nova</Button>
      </PageHeader>

      <div className="grid grid-cols-4 gap-4">
        <SummaryCard title="Saldo" value={balance} icon={<Wallet size={22} className="text-white" />} iconBg="bg-indigo-600" />
        <SummaryCard title="Receitas" value={income} icon={<TrendingUp size={22} className="text-white" />} iconBg="bg-income" valueColor="text-income" />
        <SummaryCard title="Despesas" value={expenses} icon={<TrendingDown size={22} className="text-white" />} iconBg="bg-expense" valueColor="text-expense" />
        <div className="bg-surface border border-border rounded-xl p-4 flex items-center gap-2">
          <div className="flex gap-2">
            {['all','income','expense'].map(v => (
              <button key={v} onClick={() => setFilter(v)} className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${filter === v ? 'bg-primary text-white' : 'bg-surface-2 text-muted hover:text-white'}`}>
                {v === 'all' ? 'Todas' : v === 'income' ? 'Receitas' : 'Despesas'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border text-muted text-left">{['Status','Data','Descrição','Categoria','Conta','Valor',''].map(h => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-10 text-muted">Nenhuma transação encontrada</td></tr>
            ) : filtered.map(t => (
              <tr key={t._id} className="border-b border-border last:border-0 hover:bg-surface-2 transition-colors">
                <td className="px-4 py-3">{t.status === 'paid' ? <CheckCircle2 size={16} className="text-income" /> : <Clock size={16} className="text-yellow-500" />}</td>
                <td className="px-4 py-3 text-muted">{new Date(t.date).toLocaleDateString('pt-BR')}</td>
                <td className="px-4 py-3 text-white font-medium">{t.description}</td>
                <td className="px-4 py-3">{t.categoryId ? <Badge label={(t.categoryId as any).name} color={(t.categoryId as any).color} /> : <span className="text-muted">—</span>}</td>
                <td className="px-4 py-3 text-muted">{(t.accountId as any)?.name ?? '—'}</td>
                <td className={`px-4 py-3 font-semibold ${t.type === 'income' ? 'text-income' : 'text-expense'}`}>{t.type === 'income' ? '+' : '-'}{formatBRL(t.amount)}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(t)} className="p-1 rounded hover:bg-border text-muted hover:text-white transition-colors"><Edit size={14} /></button>
                    <button onClick={() => deleteMut.mutate(t._id)} className="p-1 rounded hover:bg-border text-muted hover:text-expense transition-colors"><Trash2 size={14} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={modal} onClose={closeModal} title={editing ? 'Editar transação' : 'Nova transação'} wide>
        <form onSubmit={submit} className="grid grid-cols-2 gap-4">
          <Input label="Descrição" value={form.description} onChange={e => setForm((f: any) => ({ ...f, description: e.target.value }))} required className="col-span-2" />
          <Input label="Valor" type="number" step="0.01" min="0" value={form.amount} onChange={e => setForm((f: any) => ({ ...f, amount: Number(e.target.value) }))} required />
          <Input label="Data" type="date" value={form.date} onChange={e => setForm((f: any) => ({ ...f, date: e.target.value }))} required />
          <Select label="Tipo" options={[{value:'expense',label:'Despesa'},{value:'income',label:'Receita'}]} value={form.type} onChange={e => setForm((f: any) => ({ ...f, type: e.target.value }))} />
          <Select label="Status" options={[{value:'paid',label:'Pago'},{value:'pending',label:'Pendente'}]} value={form.status} onChange={e => setForm((f: any) => ({ ...f, status: e.target.value }))} />
          <Select label="Categoria" options={catOptions} value={form.categoryId ?? ''} onChange={e => setForm((f: any) => ({ ...f, categoryId: e.target.value || null }))} />
          <Select label="Conta" options={accOptions} value={form.accountId ?? ''} onChange={e => setForm((f: any) => ({ ...f, accountId: e.target.value || null }))} />
          <div className="col-span-2 flex gap-3 justify-end pt-2">
            <Button type="button" variant="ghost" onClick={closeModal}>Cancelar</Button>
            <Button type="submit">{editing ? 'Salvar' : 'Criar'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
