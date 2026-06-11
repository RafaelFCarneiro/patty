import { Test, TestingModule } from '@nestjs/testing';
import { ReportsService } from './reports.service';
import { TransactionsService } from '../transactions/transactions.service';

describe('ReportsService', () => {
  let service: ReportsService;
  let txService: jest.Mocked<TransactionsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        {
          provide: TransactionsService,
          useValue: { groupByCategory: jest.fn(), sumByType: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<ReportsService>(ReportsService);
    txService = module.get(TransactionsService);
  });

  describe('expensesByCategory', () => {
    it('delegates to groupByCategory with expense type', async () => {
      const data = [{ category: { name: 'Food' }, total: 500 }];
      txService.groupByCategory.mockResolvedValue(data as any);
      const result = await service.expensesByCategory(5, 2026);
      expect(txService.groupByCategory).toHaveBeenCalledWith('expense', 5, 2026);
      expect(result).toEqual(data);
    });
  });

  describe('incomeByCategory', () => {
    it('delegates to groupByCategory with income type', async () => {
      txService.groupByCategory.mockResolvedValue([]);
      await service.incomeByCategory(5, 2026);
      expect(txService.groupByCategory).toHaveBeenCalledWith('income', 5, 2026);
    });
  });

  describe('monthlyBalance', () => {
    it('returns 12 monthly entries for the given year', async () => {
      txService.sumByType.mockResolvedValue(0);
      const result = await service.monthlyBalance(2026);
      expect(result).toHaveLength(12);
      expect(result[0]).toMatchObject({ month: 1, year: 2026 });
      expect(result[11]).toMatchObject({ month: 12, year: 2026 });
    });

    it('calculates balance as income minus expenses', async () => {
      txService.sumByType
        .mockResolvedValueOnce(5000)  // Jan income
        .mockResolvedValueOnce(3000)  // Jan expenses
        .mockResolvedValue(0);
      const result = await service.monthlyBalance(2026);
      expect(result[0].income).toBe(5000);
      expect(result[0].expenses).toBe(3000);
      expect(result[0].balance).toBe(2000);
    });
  });

  describe('performance', () => {
    it('calculates savings and spending rates', async () => {
      txService.sumByType
        .mockResolvedValueOnce(5000)  // income
        .mockResolvedValueOnce(3000); // expenses
      const result = await service.performance(5, 2026);
      expect(result.savings).toBe(2000);
      expect(result.savingsRate).toBeCloseTo(40);
      expect(result.spendingRate).toBeCloseTo(60);
      expect(result.month).toBe(5);
      expect(result.year).toBe(2026);
    });

    it('returns zero rates when income is 0 to avoid division by zero', async () => {
      txService.sumByType.mockResolvedValue(0);
      const result = await service.performance(5, 2026);
      expect(result.savingsRate).toBe(0);
      expect(result.spendingRate).toBe(0);
    });

    it('handles expenses exceeding income (negative savings)', async () => {
      txService.sumByType
        .mockResolvedValueOnce(1000)  // income
        .mockResolvedValueOnce(1500); // expenses
      const result = await service.performance(5, 2026);
      expect(result.savings).toBe(-500);
      expect(result.savingsRate).toBeCloseTo(-50);
    });
  });
});
