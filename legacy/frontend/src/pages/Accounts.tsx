import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, MoreVertical, Edit, Trash2 } from 'lucide-react';
import { fetchAccounts, createAccount, updateAccount, deleteAccount, type Account } from '@/api/accounts';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatBRL } from '@/lib/utils';

const TYPE_OPTIONS = [
  { value: 'checking', label: 'Conta corrente' },
  { value: 'savings', label: 'Poupança' },
  { value: 'investment', label: 'Investimento' },
  { value: 'wallet', label: 'Carteira' },
  { value: 'other', label: 'Outro' },
];

const empty = (): Partial<Account> => ({ name: '', type: 'checking', balance: 0, color: '#6366f1', includeInTotal: true, showOnDashboard: true });

export const Accounts = () => {
  const qc = useQueryClient();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [form, setForm] = useState<Partial<Account>>(empty());
  const [menuId, setMenuId] = useState<string | null>(null);

  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['accounts'] });

  const createMut = useMutation({ mutationFn: createAccount, onSuccess: () => { invalidate(); closeModal(); } });
  const updateMut = useMutation({ mutationFn: ({ id, data }: { id: string; data: Partial<Account> }) => updateAccount(id, data), onSuccess: () => { invalidate(); closeModal(); } });
  const deleteMut = useMutation({ mutationFn: deleteAccount, onSuccess: invalidate });

  const openCreate = () => { setEditing(null); setForm(empty()); setModal(true); };
  const openEdit = (a: Account) => { setEditing(a); setForm(a); setModal(true); setMenuId(null); };
  const closeModal = () => { setModal(false); setEditing(null); };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editing) updateMut.mutate({ id: editing._id, data: form });
    else createMut.mutate(form);
  };

  const totalBalance = accounts.filter(a => a.includeInTotal).reduce((s, a) => s + a.balance, 0);

  return (
    <div className="p-6">
      <PageHeader title="Contas">
        <Button onClick={openCreate}><Plus size={16} /> Nova conta</Button>
      </PageHeader>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 space-y-4">
          {accounts.length === 0 ? (
            <EmptyState message="Nenhuma conta cadastrada" action={<Button onClick={openCreate}><Plus size={16} />Criar conta</Button>} />
          ) : accounts.map(a => (
            <div key={a._id} className="bg-surface border border-border rounded-xl p-5 relative">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm" style={{ backgroundColor: a.color }}>{a.name[0]}</div>
                  <h3 className="font-semibold text-white">{a.name}</h3>
                </div>
                <div className="relative">
                  <button onClick={() => setMenuId(menuId === a._id ? null : a._id)} className="p-1 rounded hover:bg-surface-2 text-muted hover:text-white transition-colors"><MoreVertical size={16} /></button>
                  {menuId === a._id && (
                    <div className="absolute right-0 top-8 bg-surface-2 border border-border rounded-lg shadow-xl z-10 min-w-[120px]">
                      <button onClick={() => openEdit(a)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-white hover:bg-border transition-colors"><Edit size={14} /> Editar</button>
                      <button onClick={() => { deleteMut.mutate(a._id); setMenuId(null); }} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-expense hover:bg-border transition-colors"><Trash2 size={14} /> Excluir</button>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex justify-between text-sm">
                <div><p className="text-muted">Saldo atual</p><p className="text-income font-semibold">{formatBRL(a.balance)}</p></div>
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-4">
          <div className="bg-surface border border-border rounded-xl p-5"><p className="text-muted text-sm">Saldo total</p><p className="text-white font-bold text-xl mt-1">{formatBRL(totalBalance)}</p></div>
        </div>
      </div>

      <Modal open={modal} onClose={closeModal} title={editing ? 'Editar conta' : 'Nova conta'}>
        <form onSubmit={submit} className="space-y-4">
          <Input label="Nome" value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
          <Select label="Tipo" options={TYPE_OPTIONS} value={form.type ?? 'checking'} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} />
          <Input label="Saldo inicial" type="number" step="0.01" value={form.balance ?? 0} onChange={e => setForm(f => ({ ...f, balance: Number(e.target.value) }))} />
          <div className="flex gap-3 pt-2 justify-end">
            <Button type="button" variant="ghost" onClick={closeModal}>Cancelar</Button>
            <Button type="submit">{editing ? 'Salvar' : 'Criar'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
