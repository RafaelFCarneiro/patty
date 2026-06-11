import { useState } from 'react';

const tabs = ['Preferências', 'Alertas e notificações', 'Dashboard', 'Segurança'] as const;

export const Settings = () => {
  const [tab, setTab] = useState<typeof tabs[number]>('Preferências');

  return (
    <div className="p-6 space-y-5">
      <h1 className="text-2xl font-bold text-white">Configurações</h1>

      <div className="flex gap-1 border-b border-border">
        {tabs.map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${tab === t ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-white'}`}>{t}</button>
        ))}
      </div>

      <div className="bg-surface border border-border rounded-xl p-6 max-w-lg">
        {tab === 'Preferências' && (
          <div className="space-y-5">
            <div>
              <label className="block text-sm text-muted mb-1.5">Idioma</label>
              <select disabled className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-white w-full opacity-60 cursor-not-allowed">
                <option>Português Brasil</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-muted mb-1.5">Moeda</label>
              <select disabled className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-white w-full opacity-60 cursor-not-allowed">
                <option>BRL — Real Brasileiro</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-muted mb-1.5">Aparência</label>
              <select className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-white w-full focus:outline-none focus:border-primary">
                <option>Modo escuro</option>
              </select>
            </div>
          </div>
        )}
        {tab !== 'Preferências' && (
          <p className="text-muted text-sm text-center py-8">Em breve...</p>
        )}
      </div>
    </div>
  );
};
