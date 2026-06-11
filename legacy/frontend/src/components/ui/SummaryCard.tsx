import { cn, formatBRL } from '@/lib/utils';

interface Props {
  title: string;
  value: number;
  icon: React.ReactNode;
  iconBg?: string;
  valueColor?: string;
  subtitle?: string;
}

export const SummaryCard = ({ title, value, icon, iconBg = 'bg-primary', valueColor = 'text-white', subtitle }: Props) => (
  <div className="bg-surface rounded-xl p-4 flex items-center gap-4 border border-border">
    <div className={cn('w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0', iconBg)}>
      {icon}
    </div>
    <div>
      <p className="text-sm text-muted">{title}</p>
      <p className={cn('text-lg font-bold', valueColor)}>{formatBRL(value)}</p>
      {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
    </div>
  </div>
);
