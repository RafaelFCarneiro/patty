import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { NotFoundException } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { Transaction } from './schemas/transaction.schema';

const mkChain = (resolved: any) => {
  const execFn = jest.fn().mockResolvedValue(resolved);
  const chain: any = {};
  chain.exec = execFn;
  chain.lean = jest.fn().mockReturnValue({ exec: execFn });
  chain.populate = jest.fn().mockReturnValue(chain);
  chain.sort = jest.fn().mockReturnValue(chain);
  return chain;
};

describe('TransactionsService', () => {
  let service: TransactionsService;
  let mockModel: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockModel = {
      find: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findByIdAndDelete: jest.fn(),
      create: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: getModelToken(Transaction.name), useValue: mockModel },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
  });

  describe('findAll', () => {
    it('builds a date range filter when month and year are given', async () => {
      mockModel.find.mockReturnValue(mkChain([]));
      await service.findAll({ month: 5, year: 2026 });
      const filter = mockModel.find.mock.calls[0][0];
      expect(filter.date).toHaveProperty('$gte');
      expect(filter.date).toHaveProperty('$lte');
      expect(filter.date.$gte).toEqual(new Date(2026, 4, 1));
      expect(filter.date.$lte).toEqual(new Date(2026, 5, 0, 23, 59, 59, 999));
    });

    it('includes type in filter when provided', async () => {
      mockModel.find.mockReturnValue(mkChain([]));
      await service.findAll({ type: 'income' });
      expect(mockModel.find.mock.calls[0][0]).toMatchObject({ type: 'income' });
    });

    it('applies no filter when query is empty', async () => {
      mockModel.find.mockReturnValue(mkChain([]));
      await service.findAll({});
      expect(mockModel.find.mock.calls[0][0]).toEqual({});
    });

    it('returns transactions from the model', async () => {
      const txs = [{ description: 'Salary', amount: 5000 }];
      mockModel.find.mockReturnValue(mkChain(txs));
      expect(await service.findAll({})).toEqual(txs);
    });
  });

  describe('findOne', () => {
    it('returns the transaction when found', async () => {
      const tx = { _id: 'abc', description: 'Rent', amount: 1200 };
      mockModel.findById.mockReturnValue(mkChain(tx));
      expect(await service.findOne('abc')).toEqual(tx);
    });

    it('throws NotFoundException when not found', async () => {
      mockModel.findById.mockReturnValue(mkChain(null));
      await expect(service.findOne('bad')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('creates a transaction with the dto', async () => {
      const dto = { description: 'Coffee', amount: 10, type: 'expense', date: new Date() };
      mockModel.create.mockResolvedValue({ ...dto, _id: 'new-id' });
      const result = await service.create(dto as any);
      expect(mockModel.create).toHaveBeenCalledWith(dto);
      expect(result).toMatchObject(dto);
    });
  });

  describe('update', () => {
    it('returns updated transaction', async () => {
      const existing = { _id: 'abc', description: 'Old' };
      const updated = { _id: 'abc', description: 'New' };
      mockModel.findById.mockReturnValue(mkChain(existing));
      mockModel.findByIdAndUpdate.mockReturnValue(mkChain(updated));
      expect(await service.update('abc', { description: 'New' } as any)).toEqual(updated);
    });

    it('throws when transaction does not exist', async () => {
      mockModel.findById.mockReturnValue(mkChain(null));
      await expect(service.update('bad', {} as any)).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes and returns removed transaction', async () => {
      const tx = { _id: 'abc', description: 'Rent' };
      mockModel.findById.mockReturnValue(mkChain(tx));
      mockModel.findByIdAndDelete.mockReturnValue(mkChain(tx));
      expect(await service.remove('abc')).toEqual(tx);
    });

    it('throws when transaction does not exist', async () => {
      mockModel.findById.mockReturnValue(mkChain(null));
      await expect(service.remove('bad')).rejects.toThrow(NotFoundException);
    });
  });

  describe('sumByType', () => {
    it('sums amounts for the given type in the period', async () => {
      mockModel.find.mockReturnValue(mkChain([{ amount: 3000 }, { amount: 2000 }]));
      expect(await service.sumByType('income', 5, 2026)).toBe(5000);
    });

    it('returns 0 when no transactions match', async () => {
      mockModel.find.mockReturnValue(mkChain([]));
      expect(await service.sumByType('expense', 1, 2026)).toBe(0);
    });

    it('calls find with the correct type filter', async () => {
      mockModel.find.mockReturnValue(mkChain([]));
      await service.sumByType('expense', 5, 2026);
      expect(mockModel.find.mock.calls[0][0]).toMatchObject({ type: 'expense' });
    });
  });

  describe('pendingSum', () => {
    it('sums pending amounts for the given type', async () => {
      mockModel.find.mockReturnValue(mkChain([{ amount: 400 }, { amount: 600 }]));
      expect(await service.pendingSum('expense', 5, 2026)).toBe(1000);
    });

    it('filters by pending status', async () => {
      mockModel.find.mockReturnValue(mkChain([]));
      await service.pendingSum('expense', 5, 2026);
      expect(mockModel.find.mock.calls[0][0]).toMatchObject({ status: 'pending', type: 'expense' });
    });
  });

  describe('groupByDate', () => {
    it('groups transactions by their ISO date string', async () => {
      const d1 = new Date('2026-05-10T12:00:00Z');
      const d2 = new Date('2026-05-15T08:00:00Z');
      mockModel.find.mockReturnValue(mkChain([
        { amount: 100, date: d1 },
        { amount: 200, date: d1 },
        { amount: 50, date: d2 },
      ]));
      const result = await service.groupByDate(5, 2026);
      expect(Object.keys(result)).toHaveLength(2);
      expect(result[d1.toISOString().slice(0, 10)]).toHaveLength(2);
      expect(result[d2.toISOString().slice(0, 10)]).toHaveLength(1);
    });
  });

  describe('groupByCategory', () => {
    it('groups by categoryId and sums totals', async () => {
      const cat = { _id: { toString: () => 'cat1' }, name: 'Food' };
      mockModel.find.mockReturnValue(mkChain([
        { amount: 100, categoryId: cat },
        { amount: 200, categoryId: cat },
      ]));
      const result = await service.groupByCategory('expense', 5, 2026);
      expect(result).toHaveLength(1);
      expect(result[0].total).toBe(300);
      expect(result[0].category).toEqual(cat);
    });

    it('labels transactions without a category as Sem categoria', async () => {
      mockModel.find.mockReturnValue(mkChain([{ amount: 50, categoryId: null }]));
      const result = await service.groupByCategory('expense', 5, 2026);
      expect(result[0].category).toMatchObject({ name: 'Sem categoria' });
    });
  });
});
