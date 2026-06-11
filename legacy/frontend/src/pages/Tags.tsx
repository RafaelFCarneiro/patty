import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Edit, Trash2 } from 'lucide-react';
import { fetchTags, createTag, updateTag, deleteTag, type Tag } from '@/api/tags';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';

export const Tags = () => {
  const qc = useQueryClient();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<Tag | null>(null);
  const [name, setName] = useState('');

  const { data: tags = [] } = useQuery({ queryKey: ['tags'], queryFn: fetchTags });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['tags'] });
  const createMut = useMutation({ mutationFn: createTag, onSuccess: () => { invalidate(); closeModal(); } });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => updateTag(id, data), onSuccess: () => { invalidate(); closeModal(); } });
  const deleteMut = useMutation({ mutationFn: deleteTag, onSuccess: invalidate });

  const openCreate = () => { setEditing(null); setName(''); setModal(true); };
  const openEdit = (t: Tag) => { setEditing(t); setName(t.name); setModal(true); };
  const closeModal = () => { setModal(false); setEditing(null); setName(''); };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editing) updateMut.mutate({ id: editing._id, data: { name } });
    else createMut.mutate({ name });
  };

  return (
    <div className="p-6 space-y-5">
      <PageHeader title="Tags">
        <Button onClick={openCreate}><Plus size={16} /> Nova tag</Button>
      </PageHeader>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="text-muted text-left border-b border-border"><th className="px-5 py-3 font-medium">Nome</th><th className="px-5 py-3 font-medium">Ações</th></tr></thead>
          <tbody>
            {tags.length === 0 ? (
              <tr><td colSpan={2} className="py-10"><EmptyState message="Nenhuma tag criada" action={<Button onClick={openCreate}><Plus size={16} />Criar tag</Button>} /></td></tr>
            ) : tags.map(t => (
              <tr key={t._id} className="border-b border-border last:border-0 hover:bg-surface-2 transition-colors">
                <td className="px-5 py-3 text-white"># {t.name}</td>
                <td className="px-5 py-3">
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

      <Modal open={modal} onClose={closeModal} title={editing ? 'Editar tag' : 'Nova tag'}>
        <form onSubmit={submit} className="space-y-4">
          <Input label="Nome da tag" value={name} onChange={e => setName(e.target.value)} required placeholder="ex: viagem, trabalho..." />
          <div className="flex gap-3 pt-2 justify-end">
            <Button type="button" variant="ghost" onClick={closeModal}>Cancelar</Button>
            <Button type="submit">{editing ? 'Salvar' : 'Criar'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
