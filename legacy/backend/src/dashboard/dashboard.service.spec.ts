import { Test, TestingModule } from '@nestjs/testing';
import { DashboardService } from './dashboard.service';
import { AccountsService } from '../accounts/accounts.service';
import { TransactionsService } from '../transactions/transactions.service';
import { CreditCardsService } from '../credit-cards/credit-cards.service';

describe('DashboardService', () => {
  let service: DashboardService;
  let accountsService: jest.Mocked<AccountsService>;
  let transactionsService: jest.Mocked<TransactionsService>;
  let creditCardsService: jest.Mocked<CreditCardsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        {
          provide: AccountsService,
          useValue: { sumBalances: jest.fn() },
        },
        {
          provide: TransactionsService,
          useValue: { sumByType: jest.fn(), pendingSum: jest.fn(), groupByDate: jest.fn() },
        },
        {
          provide: CreditCardsService,
          useValue: { findAll: jest.fn(), totalUsed: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<DashboardService>(DashboardService);
    accountsService = module.get(AccountsService);
    transactionsService = module.get(TransactionsService);
    creditCardsService = module.get(CreditCardsService);
  });

  describe('summary', () => {
    it('aggregates balance, income, expenses, pending and credit card totals', async () => {
      accountsService.sumBalances.mockResolvedValue(10000);
      transactionsService.sumByType
        .mockResolvedValueOnce(5000)  // income
        .mockResolvedValueOnce(2000); // expenses
      transactionsService.pendingSum
        .mockResolvedValueOnce(500)   // pendingExpenses
        .mockResolvedValueOnce(0);    // pendingIncome
      creditCardsService.findAll.mockResolvedValue([{ _id: { toString: () => 'cc1' } }] as any);
      creditCardsService.totalUsed.mockResolvedValue(300);

      const result = await service.summary(5, 2026);

      expect(result).toEqual({
        balance: 10000,
        income: 5000,
        expenses: 2000,
        pendingExpenses: 500,
        pendingIncome: 0,
        creditCardTotal: 300,
      });
    });

    it('sums totalUsed across multiple credit cards', async () => {
      accountsService.sumBalances.mockResolvedValue(0);
      transactionsService.sumByType.mockResolvedValue(0);
      transactionsService.pendingSum.mockResolvedValue(0);
      creditCardsService.findAll.mockResolvedValue([
        { _id: { toString: () => 'cc1' } },
        { _id: { toString: () => 'cc2' } },
      ] as any);
      creditCardsService.totalUsed
        .mockResolvedValueOnce(400)
        .mockResolvedValueOnce(600);

      const result = await service.summary(5, 2026);
      expect(result.creditCardTotal).toBe(1000);
    });
  });

  describe('calendar', () => {
    it('maps grouped transactions into calendar day entries', async () => {
      transactionsService.groupByDate.mockResolvedValue({
        '2026-05-10': [
          { type: 'income', amount: 1000 },
          { type: 'expense', amount: 400 },
        ],
        '2026-05-15': [
          { type: 'expense', amount: 200 },
        ],
      } as any);

      const result = await service.calendar(5, 2026);

      expect(result).toHaveLength(2);
      const day10 = result.find((r) => r.date === '2026-05-10')!;
      expect(day10.income).toBe(1000);
      expect(day10.expenses).toBe(400);
      const day15 = result.find((r) => r.date === '2026-05-15')!;
      expect(day15.income).toBe(0);
      expect(day15.expenses).toBe(200);
    });

    it('returns an empty array when there are no transactions', async () => {
      transactionsService.groupByDate.mockResolvedValue({});
      expect(await service.calendar(5, 2026)).toEqual([]);
    });
  });
});
