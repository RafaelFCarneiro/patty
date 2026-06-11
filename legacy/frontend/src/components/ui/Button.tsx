import { cn } from '@/lib/utils';

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}

const variants = {
  primary: 'bg-primary hover:bg-primary-hover text-white',
  ghost: 'bg-surface-2 hover:bg-border text-white',
  danger: 'bg-expense hover:bg-red-600 text-white',
};

const sizes = { sm: 'px-3 py-1.5 text-xs', md: 'px-4 py-2 text-sm' };

export const Button = ({ variant = 'primary', size = 'md', className, children, ...props }: Props) => (
  <button
    {...props}
    className={cn('rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2', variants[variant], sizes[size], className)}
  >
    {children}
  </button>
);
