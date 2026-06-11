import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Edit, Trash2 } from 'lucide-react';
import { fetchCategories, createCategory, updateCategory, deleteCategory, type Category } from '@/api/categories';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';

const emptyForm = (type: 'expense' | 'income' = 'expense'): Partial<Category> => ({ name: '', type, icon: 'tag', color: '#6366f1', parentId: null });

export const Categories = () => {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'expense' | 'income'>('expense');
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const [form, setForm] = useState<Partial<Category>>(emptyForm());

  const { data: all = [] } = useQuery({ queryKey: ['categories'], queryFn: () => fetchCategories() });
  const categories = all.filter(c => c.type === tab);
  const parents = categories.filter(c => !c.parentId);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['categories'] });
  const createMut = useMutation({ mutationFn: createCategory, onSuccess: () => { invalidate(); closeModal(); } });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => updateCategory(id, data), onSuccess: () => { invalidate(); closeModal(); } });
  const deleteMut = useMutation({ mutationFn: deleteCategory, onSuccess: invalidate });

  const openCreate = (parentId?: string) => { setEditing(null); setForm({ ...emptyForm(tab), parentId: parentId ?? null }); setModal(true); };
  const openEdit = (c: Category) => { setEditing(c); setForm(c); setModal(true); };
  const closeModal = () => { setModal(false); setEditing(null); };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editing) updateMut.mutate({ id: editing._id, data: form });
    else createMut.mutate({ ...form, type: tab });
  };

  const renderRow = (c: Category, isChild = false) => (
    <tr key={c._id} className="border-b border-border last:border-0 hover:bg-surface-2 transition-colors">
      <td className="px-5 py-3">
        <div className="flex items-center gap-2">
          {isChild && <span className="text-muted ml-3">↳</span>}
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: c.color }} />
          <span className="text-white text-sm">{c.name}</span>
        </div>
      </td>
      <td className="px-5 py-3 text-muted text-sm">{c.icon}</td>
      <td className="px-5 py-3">
        <div className="flex gap-1">
          <button onClick={() => openEdit(c)} className="p-1 rounded hover:bg-border text-muted hover:text-white transition-colors"><Edit size={14} /></button>
          <button onClick={() => deleteMut.mutate(c._id)} className="p-1 rounded hover:bg-border text-muted hover:text-expense transition-colors"><Trash2 size={14} /></button>
          {!isChild && <button onClick={() => openCreate(c._id)} className="p-1 rounded hover:bg-border text-muted hover:text-income transition-colors"><Plus size={14} /></button>}
        </div>
      </td>
    </tr>
  );

  return (
    <div className="p-6 space-y-5">
      <PageHeader title="Categorias">
        <div className="flex gap-2 bg-surface-2 rounded-lg p-1">
          {(['expense','income'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} className={`px-4 py-1.5 rounded text-sm transition-colors ${tab === t ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}>
              {t === 'expense' ? 'Despesas' : 'Receitas'}
            </button>
          ))}
        </div>
        <Button onClick={() => openCreate()}><Plus size={16} /> Nova categoria</Button>
      </PageHeader>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="text-muted text-left border-b border-border">{['Nome','Ícone','Ações'].map(h => <th key={h} className="px-5 py-3 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {parents.length === 0 ? (
              <tr><td colSpan={3} className="text-center py-10 text-muted">Nenhuma categoria</td></tr>
            ) : parents.flatMap(p => [
              renderRow(p, false),
              ...all.filter(c => c.parentId === p._id).map(c => renderRow(c, true)),
            ])}
          </tbody>
        </table>
      </div>

      <Modal open={modal} onClose={closeModal} title={editing ? 'Editar categoria' : 'Nova categoria'}>
        <form onSubmit={submit} className="space-y-4">
          <Input label="Nome" value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
          <Input label="Ícone (emoji ou nome)" value={form.icon ?? ''} onChange={e => setForm(f => ({ ...f, icon: e.target.value }))} />
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
