import { cn } from '@/lib/utils';

interface Option { value: string; label: string; }
interface Props extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: Option[];
}

export const Select = ({ label, options, className, ...props }: Props) => (
  <label className="flex flex-col gap-1.5">
    {label && <span className="text-sm text-muted">{label}</span>}
    <select
      {...props}
      className={cn(
        'bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary transition-colors',
        className,
      )}
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </label>
);
