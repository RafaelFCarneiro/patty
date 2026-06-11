import { cn } from '@/lib/utils';

interface Props extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export const Input = ({ label, className, ...props }: Props) => (
  <label className="flex flex-col gap-1.5">
    {label && <span className="text-sm text-muted">{label}</span>}
    <input
      {...props}
      className={cn(
        'bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-white placeholder:text-muted focus:outline-none focus:border-primary transition-colors',
        className,
      )}
    />
  </label>
);
