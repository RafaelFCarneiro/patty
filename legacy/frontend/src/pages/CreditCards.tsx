import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, MoreVertical, Edit, Trash2 } from 'lucide-react';
import { fetchCreditCards, createCreditCard, updateCreditCard, deleteCreditCard, fetchBills, payBill, type CreditCard } from '@/api/credit-cards';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatBRL } from '@/lib/utils';

const emptyForm = (): Partial<CreditCard> => ({ name: '', limit: 0, closingDay: 5, dueDay: 10, color: '#06b6d4' });

const CardProgress = ({ used, limit }: { used: number; limit: number }) => {
  const pct = Math.min(100, (used / (limit || 1)) * 100);
  return (
    <div className="mt-3">
      <div className="w-full bg-surface-2 rounded-full h-2"><div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: pct > 85 ? '#ef4444' : '#06b6d4' }} /></div>
      <p className="text-xs text-muted mt-1">{pct.toFixed(1)}% • Limite disponível: {formatBRL(limit - used)}</p>
    </div>
  );
};

export const CreditCards = () => {
  const qc = useQueryClient();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<CreditCard | null>(null);
  const [form, setForm] = useState<Partial<CreditCard>>(emptyForm());
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [menuId, setMenuId] = useState<string | null>(null);

  const { data: cards = [] } = useQuery({ queryKey: ['credit-cards'], queryFn: fetchCreditCards });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['credit-cards'] });
  const createMut = useMutation({ mutationFn: createCreditCard, onSuccess: () => { invalidate(); closeModal(); } });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => updateCreditCard(id, data), onSuccess: () => { invalidate(); closeModal(); } });
  const deleteMut = useMutation({ mutationFn: deleteCreditCard, onSuccess: invalidate });

  const openCreate = () => { setEditing(null); setForm(emptyForm()); setModal(true); };
  const openEdit = (c: CreditCard) => { setEditing(c); setForm(c); setModal(true); setMenuId(null); };
  const closeModal = () => { setModal(false); setEditing(null); };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editing) updateMut.mutate({ id: editing._id, data: form });
    else createMut.mutate(form);
  };

  const totalLimit = cards.reduce((s, c) => s + c.limit, 0);

  return (
    <div className="p-6 space-y-5">
      <PageHeader title="Cartões de crédito">
        <div className="flex gap-2">
          <button onClick={() => setTab('open')} className={`px-4 py-1.5 rounded-full text-sm transition-colors ${tab === 'open' ? 'bg-surface-2 text-white' : 'text-muted hover:text-white'}`}>Faturas abertas</button>
          <button onClick={() => setTab('closed')} className={`px-4 py-1.5 rounded-full text-sm transition-colors ${tab === 'closed' ? 'bg-accent text-white' : 'text-muted hover:text-white'}`}>Faturas fechadas</button>
        </div>
        <Button onClick={openCreate}><Plus size={16} /> Novo cartão</Button>
      </PageHeader>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 space-y-4">
          {cards.length === 0 ? (
            <EmptyState message="Nenhum cartão cadastrado" action={<Button onClick={openCreate}><Plus size={16} />Adicionar cartão</Button>} />
          ) : cards.map(c => (
            <div key={c._id} className="bg-surface border border-border rounded-xl p-5">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-sm" style={{ backgroundColor: c.color }}>{c.name[0]}</div>
                  <div><h3 className="font-semibold text-white">{c.name}</h3><p className="text-xs text-muted">Fecha dia {c.closingDay} · Vence dia {c.dueDay}</p></div>
                </div>
                <div className="relative flex items-center gap-3">
                  <span className="text-lg font-bold text-white">{formatBRL(c.limit)}</span>
                  <div className="relative">
                    <button onClick={() => setMenuId(menuId === c._id ? null : c._id)} className="p-1 rounded hover:bg-surface-2 text-muted hover:text-white transition-colors"><MoreVertical size={16} /></button>
                    {menuId === c._id && (
                      <div className="absolute right-0 top-8 bg-surface-2 border border-border rounded-lg shadow-xl z-10 min-w-[120px]">
                        <button onClick={() => openEdit(c)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-white hover:bg-border"><Edit size={14} /> Editar</button>
                        <button onClick={() => { deleteMut.mutate(c._id); setMenuId(null); }} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-expense hover:bg-border"><Trash2 size={14} /> Excluir</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <CardProgress used={0} limit={c.limit} />
            </div>
          ))}
        </div>

        <div className="space-y-4">
          <div className="bg-surface border border-border rounded-xl p-5"><p className="text-muted text-sm">Limite total disponível</p><p className="text-white font-bold text-xl mt-1">{formatBRL(totalLimit)}</p></div>
        </div>
      </div>

      <Modal open={modal} onClose={closeModal} title={editing ? 'Editar cartão' : 'Novo cartão'}>
        <form onSubmit={submit} className="space-y-4">
          <Input label="Nome do cartão" value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
          <Input label="Limite (R$)" type="number" step="0.01" min="0" value={form.limit ?? 0} onChange={e => setForm(f => ({ ...f, limit: Number(e.target.value) }))} required />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Dia fechamento" type="number" min="1" max="31" value={form.closingDay ?? 5} onChange={e => setForm(f => ({ ...f, closingDay: Number(e.target.value) }))} required />
            <Input label="Dia vencimento" type="number" min="1" max="31" value={form.dueDay ?? 10} onChange={e => setForm(f => ({ ...f, dueDay: Number(e.target.value) }))} required />
          </div>
          <Input label="Cor" type="color" value={form.color ?? '#06b6d4'} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} />
          <div className="flex gap-3 pt-2 justify-end">
            <Button type="button" variant="ghost" onClick={closeModal}>Cancelar</Button>
            <Button type="submit">{editing ? 'Salvar' : 'Criar'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
