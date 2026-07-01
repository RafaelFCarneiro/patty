import { z } from 'zod';

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export type IsoDate = z.infer<typeof IsoDate>;

export const PeriodSchema = z.object({
  month: z.number().int().min(1).max(12).describe('Month (1–12)'),
  year: z.number().int().min(2000).max(2100).describe('Calendar year'),
});
export type Period = z.infer<typeof PeriodSchema>;

export type DateRange = { from: string; to: string };
export type NullableDateRange = { from: string | null; to: string | null };
export type PeriodInput = { month?: number | null; year?: number | null; from?: IsoDate | null; to?: IsoDate | null };
