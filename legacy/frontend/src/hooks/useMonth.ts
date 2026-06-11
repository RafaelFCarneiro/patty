import { useState } from 'react';
import { currentMonth, currentYear } from '@/lib/utils';

export const useMonth = () => {
  const [month, setMonth] = useState(currentMonth());
  const [year, setYear] = useState(currentYear());

  const prev = () => {
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  };
  const next = () => {
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  };

  return { month, year, prev, next };
};
