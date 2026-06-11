import { ChevronLeft, ChevronRight } from 'lucide-react';
import { MONTH_NAMES } from '@/lib/utils';

interface Props { month: number; year: number; onPrev: () => void; onNext: () => void; }

export const MonthPicker = ({ month, year, onPrev, onNext }: Props) => (
  <div className="flex items-center gap-2">
    <button onClick={onPrev} className="p-1 rounded hover:bg-surface-2 text-muted hover:text-white transition-colors">
      <ChevronLeft size={18} />
    </button>
    <span className="text-sm font-semibold border border-primary rounded-full px-4 py-1 text-primary min-w-[140px] text-center">
      {MONTH_NAMES[month - 1]} {year}
    </span>
    <button onClick={onNext} className="p-1 rounded hover:bg-surface-2 text-muted hover:text-white transition-colors">
      <ChevronRight size={18} />
    </button>
  </div>
);
