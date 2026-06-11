import { cn } from '@/lib/utils';

interface Props { label: string; color?: string; className?: string; }

export const Badge = ({ label, color, className }: Props) => (
  <span
    className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium', className)}
    style={color ? { backgroundColor: color + '33', color } : undefined}
  >
    {label}
  </span>
);
