import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Landmark, List, CreditCard, BookOpen,
  BarChart2, Target, Tag, Layers, Calendar, TrendingUp,
  Upload, Settings, HelpCircle, ChevronDown, ChevronUp, Plus,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const navItem = (to: string, icon: React.ReactNode, label: string) => ({ to, icon, label });

const main = [
  navItem('/', <LayoutDashboard size={20} />, 'Dashboard'),
  navItem('/accounts', <Landmark size={20} />, 'Contas'),
  navItem('/transactions', <List size={20} />, 'Transações'),
  navItem('/credit-cards', <CreditCard size={20} />, 'Cartões de crédito'),
  navItem('/planning', <BookOpen size={20} />, 'Planejamento'),
  navItem('/reports', <BarChart2 size={20} />, 'Relatórios'),
];

const more = [
  navItem('/goals', <Target size={20} />, 'Objetivos'),
  navItem('/categories', <Layers size={20} />, 'Categorias'),
  navItem('/tags', <Tag size={20} />, 'Tags'),
  navItem('/calendar', <Calendar size={20} />, 'Calendário'),
  navItem('/performance', <TrendingUp size={20} />, 'Meu Desempenho'),
  navItem('/import', <Upload size={20} />, 'Importar dados'),
];

interface ItemProps { to: string; icon: React.ReactNode; label: string; collapsed: boolean; }

const Item = ({ to, icon, label, collapsed }: ItemProps) => (
  <NavLink
    to={to}
    end={to === '/'}
    className={({ isActive }) =>
      cn(
        'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
        isActive ? 'bg-primary text-white' : 'text-muted hover:bg-surface-2 hover:text-white',
      )
    }
  >
    <span className="flex-shrink-0">{icon}</span>
    {!collapsed && <span>{label}</span>}
  </NavLink>
);

export const Sidebar = () => {
  const [collapsed, setCollapsed] = useState(false);
  const [showMore, setShowMore] = useState(false);

  return (
    <aside className={cn('flex flex-col bg-surface border-r border-border transition-all duration-200 min-h-screen', collapsed ? 'w-16' : 'w-56')}>
      <div className="p-3 flex items-center justify-between border-b border-border">
        {!collapsed && <span className="font-bold text-white text-lg">FinTrack</span>}
        <button
          onClick={() => setCollapsed(c => !c)}
          className="p-1.5 rounded hover:bg-surface-2 text-muted hover:text-white transition-colors ml-auto"
        >
          <ChevronDown size={16} className={cn('transition-transform', collapsed ? '-rotate-90' : 'rotate-90')} />
        </button>
      </div>

      <div className="p-2">
        <button className="w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-white rounded-lg p-2.5 transition-colors mb-2">
          <Plus size={18} />
          {!collapsed && <span className="text-sm font-medium">Nova transação</span>}
        </button>
      </div>

      <nav className="flex-1 px-2 space-y-0.5 overflow-y-auto">
        {main.map(i => <Item key={i.to} {...i} collapsed={collapsed} />)}

        <button
          onClick={() => setShowMore(s => !s)}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-muted hover:bg-surface-2 hover:text-white transition-colors"
        >
          <span className="flex-shrink-0">···</span>
          {!collapsed && (
            <>
              <span className="flex-1 text-left">Mais opções</span>
              {showMore ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </>
          )}
        </button>

        {showMore && more.map(i => <Item key={i.to} {...i} collapsed={collapsed} />)}

        <Item to="/settings" icon={<Settings size={20} />} label="Configurações" collapsed={collapsed} />
      </nav>

      <div className="p-3 border-t border-border">
        <a
          href="https://github.com"
          target="_blank"
          rel="noreferrer"
          className={cn('flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-muted hover:bg-surface-2 hover:text-white transition-colors')}
        >
          <HelpCircle size={20} />
          {!collapsed && <span>Ajuda</span>}
        </a>
        {!collapsed && <p className="text-xs text-muted mt-2 px-3">fintrack v1.0.0</p>}
      </div>
    </aside>
  );
};
