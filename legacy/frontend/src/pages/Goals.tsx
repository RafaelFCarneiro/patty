import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Edit, Trash2, CheckCircle2 } from 'lucide-react';
import { fetchGoals, createGoal, updateGoal, deleteGoal, type Goal } from '@/api/goals';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatBRL } from '@/lib/utils';

const emptyForm = (): Partial<Goal> => ({ name: '', targetAmount: 0, currentAmount: 0, color: '#6366f1', icon: 'target' });

export const Goals = () => {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'active' | 'completed'>('active');
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [form, setForm] = useState<Partial<Goal>>(emptyForm());

  const { data: goals = [] } = useQuery({ queryKey: ['goals', tab], queryFn: () => fetchGoals(tab) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['goals'] });
  const createMut = useMutation({ mutationFn: createGoal, onSuccess: () => { invalidate(); closeModal(); } });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => updateGoal(id, data), onSuccess: () => { invalidate(); closeModal(); } });
  const deleteMut = useMutation({ mutationFn: deleteGoal, onSuccess: invalidate });
  const completeMut = useMutation({ mutationFn: (id: string) => updateGoal(id, { status: 'completed' }), onSuccess: invalidate });

  const openCreate = () => { setEditing(null); setForm(emptyForm()); setModal(true); };
  const openEdit = (g: Goal) => { setEditing(g); setForm(g); setModal(true); };
  const closeModal = () => { setModal(false); setEditing(null); };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editing) updateMut.mutate({ id: editing._id, data: form });
    else createMut.mutate(form);
  };

  return (
    <div className="p-6 space-y-5">
      <PageHeader title="Objetivos">
        <div className="flex gap-2 bg-surface-2 rounded-lg p-1">
          {(['active','completed'] as const).map(s => (
            <button key={s} onClick={() => setTab(s)} className={`px-4 py-1.5 rounded text-sm transition-colors ${tab === s ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}>
              {s === 'active' ? 'Em andamento' : 'Concluídos'}
            </button>
          ))}
        </div>
        <Button onClick={openCreate}><Plus size={16} /> Novo objetivo</Button>
      </PageHeader>

      {goals.length === 0 ? (
        <EmptyState message="Nenhum objetivo encontrado" action={<Button onClick={openCreate}><Plus size={16} />Criar objetivo</Button>} />
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {goals.map(g => {
            const pct = Math.min(100, (g.currentAmount / (g.targetAmount || 1)) * 100);
            return (
              <div key={g._id} className="bg-surface border border-border rounded-xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center text-xl" style={{ backgroundColor: g.color + '33' }}>🎯</div>
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(g)} className="p-1 rounded hover:bg-surface-2 text-muted hover:text-white transition-colors"><Edit size={14} /></button>
                    {tab === 'active' && <button onClick={() => completeMut.mutate(g._id)} className="p-1 rounded hover:bg-surface-2 text-muted hover:text-income transition-colors"><CheckCircle2 size={14} /></button>}
                    <button onClick={() => deleteMut.mutate(g._id)} className="p-1 rounded hover:bg-surface-2 text-muted hover:text-expense transition-colors"><Trash2 size={14} /></button>
                  </div>
                </div>
                <h3 className="font-semibold text-white mb-1">{g.name}</h3>
                {g.targetDate && <p className="text-xs text-muted mb-3">Meta: {new Date(g.targetDate).toLocaleDateString('pt-BR')}</p>}
                <div className="w-full bg-surface-2 rounded-full h-2 mb-2"><div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: g.color }} /></div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted">{formatBRL(g.currentAmount)}</span>
                  <span className="text-white font-semibold">{formatBRL(g.targetAmount)}</span>
                </div>
                <p className="text-xs text-muted text-center mt-1">{pct.toFixed(0)}% concluído</p>
              </div>
            );
          })}
        </div>
      )}

      <Modal open={modal} onClose={closeModal} title={editing ? 'Editar objetivo' : 'Novo objetivo'}>
        <form onSubmit={submit} className="space-y-4">
          <Input label="Nome" value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
          <Input label="Valor alvo (R$)" type="number" step="0.01" min="0" value={form.targetAmount ?? 0} onChange={e => setForm(f => ({ ...f, targetAmount: Number(e.target.value) }))} required />
          <Input label="Valor atual (R$)" type="number" step="0.01" min="0" value={form.currentAmount ?? 0} onChange={e => setForm(f => ({ ...f, currentAmount: Number(e.target.value) }))} />
          <Input label="Data alvo" type="date" value={form.targetDate?.toString().slice(0, 10) ?? ''} onChange={e => setForm(f => ({ ...f, targetDate: e.target.value as any }))} />
          <Input label="Cor" type="color" value={form.color ?? '#6366f1'} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} />
          <div className="flex gap-3 pt-2 justify-end">
            <Button type="button" variant="ghost" onClick={closeModal}>Cancelar</Button>
            <Button type="submit">{editing ? 'Salvar' : 'Criar'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
