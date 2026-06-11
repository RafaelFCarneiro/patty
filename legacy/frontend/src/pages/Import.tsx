import { useRef } from 'react';
import { Upload, Download } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { fetchTransactions } from '@/api/transactions';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { useMonth } from '@/hooks/useMonth';
import { formatBRL } from '@/lib/utils';

const downloadCsv = (rows: any[]) => {
  const headers = 'Descrição,Valor,Tipo,Data,Status,Notas';
  const lines = rows.map(t => `"${t.description}",${t.amount},${t.type},${t.date.slice(0,10)},${t.status},"${t.notes}"`);
  const csv = [headers, ...lines].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'transacoes.csv';
  a.click();
};

export const Import = () => {
  const { month, year } = useMonth();
  const { data: transactions = [] } = useQuery({ queryKey: ['transactions', month, year], queryFn: () => fetchTransactions({ month, year }) });
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="p-6 space-y-5">
      <PageHeader title="Importar / Exportar dados" />

      <div className="grid grid-cols-2 gap-5">
        <div className="bg-surface border border-border rounded-xl p-6 text-center space-y-4">
          <div className="w-14 h-14 bg-primary/10 rounded-full flex items-center justify-center mx-auto"><Upload size={24} className="text-primary" /></div>
          <h3 className="font-semibold text-white">Importar dados</h3>
          <p className="text-muted text-sm">Importe transações via arquivo CSV ou OFX do seu banco.</p>
          <input ref={fileRef} type="file" accept=".csv,.ofx" className="hidden" />
          <div className="flex gap-3 justify-center">
            <Button onClick={() => fileRef.current?.click()}>Importar CSV</Button>
          </div>
          <p className="text-xs text-muted">Formato esperado: Descrição, Valor, Tipo, Data</p>
        </div>

        <div className="bg-surface border border-border rounded-xl p-6 text-center space-y-4">
          <div className="w-14 h-14 bg-income/10 rounded-full flex items-center justify-center mx-auto"><Download size={24} className="text-income" /></div>
          <h3 className="font-semibold text-white">Exportar transações</h3>
          <p className="text-muted text-sm">Exporte as transações do mês atual em formato CSV.</p>
          <Button variant="ghost" onClick={() => downloadCsv(transactions)}><Download size={16} /> Baixar CSV ({transactions.length} transações)</Button>
        </div>
      </div>
    </div>
  );
};
