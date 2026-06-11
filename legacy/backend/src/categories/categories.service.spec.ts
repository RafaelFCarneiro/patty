import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { NotFoundException } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { Category } from './schemas/category.schema';

const mkChain = (resolved: any) => {
  const execFn = jest.fn().mockResolvedValue(resolved);
  const chain: any = {};
  chain.exec = execFn;
  chain.lean = jest.fn().mockReturnValue({ exec: execFn });
  chain.populate = jest.fn().mockReturnValue(chain);
  chain.sort = jest.fn().mockReturnValue(chain);
  return chain;
};

const ALL_CATEGORIES = [
  { name: 'Salary', type: 'income' },
  { name: 'Food', type: 'expense' },
  { name: 'Transport', type: 'expense' },
];

describe('CategoriesService', () => {
  let service: CategoriesService;
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
        CategoriesService,
        { provide: getModelToken(Category.name), useValue: mockModel },
      ],
    }).compile();

    service = module.get<CategoriesService>(CategoriesService);
  });

  describe('findAll', () => {
    it('returns all categories when no type filter given', async () => {
      mockModel.find.mockReturnValue(mkChain(ALL_CATEGORIES));
      expect(await service.findAll()).toHaveLength(3);
    });

    it('filters to only expense categories', async () => {
      mockModel.find.mockReturnValue(mkChain(ALL_CATEGORIES));
      const result = await service.findAll('expense');
      expect(result).toHaveLength(2);
      expect(result.every((c: any) => c.type === 'expense')).toBe(true);
    });

    it('filters to only income categories', async () => {
      mockModel.find.mockReturnValue(mkChain(ALL_CATEGORIES));
      const result = await service.findAll('income');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ type: 'income' });
    });
  });

  describe('findOne', () => {
    it('returns the category when found', async () => {
      const cat = { _id: 'cat1', name: 'Food', type: 'expense' };
      mockModel.findById.mockReturnValue(mkChain(cat));
      expect(await service.findOne('cat1')).toEqual(cat);
    });

    it('throws NotFoundException when not found', async () => {
      mockModel.findById.mockReturnValue(mkChain(null));
      await expect(service.findOne('bad')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('creates a category with the dto', async () => {
      const dto = { name: 'Health', type: 'expense' };
      mockModel.create.mockResolvedValue({ ...dto, _id: 'new' });
      const result = await service.create(dto as any);
      expect(mockModel.create).toHaveBeenCalledWith(dto);
      expect(result).toMatchObject(dto);
    });
  });

  describe('update', () => {
    it('returns the updated category', async () => {
      const existing = { _id: 'cat1', name: 'Old' };
      const updated = { _id: 'cat1', name: 'New' };
      mockModel.findById.mockReturnValue(mkChain(existing));
      mockModel.findByIdAndUpdate.mockReturnValue(mkChain(updated));
      expect(await service.update('cat1', { name: 'New' } as any)).toEqual(updated);
    });

    it('throws when category does not exist', async () => {
      mockModel.findById.mockReturnValue(mkChain(null));
      await expect(service.update('bad', {} as any)).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes and returns the removed category', async () => {
      const cat = { _id: 'cat1', name: 'Food' };
      mockModel.findById.mockReturnValue(mkChain(cat));
      mockModel.findByIdAndDelete.mockReturnValue(mkChain(cat));
      expect(await service.remove('cat1')).toEqual(cat);
    });

    it('throws when category does not exist', async () => {
      mockModel.findById.mockReturnValue(mkChain(null));
      await expect(service.remove('bad')).rejects.toThrow(NotFoundException);
    });
  });
});
