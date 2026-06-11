import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { NotFoundException } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { Account } from './schemas/account.schema';

const mkChain = (resolved: any) => {
  const execFn = jest.fn().mockResolvedValue(resolved);
  const chain: any = {};
  chain.exec = execFn;
  chain.lean = jest.fn().mockReturnValue({ exec: execFn });
  chain.populate = jest.fn().mockReturnValue(chain);
  chain.sort = jest.fn().mockReturnValue(chain);
  return chain;
};

describe('AccountsService', () => {
  let service: AccountsService;
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
        AccountsService,
        { provide: getModelToken(Account.name), useValue: mockModel },
      ],
    }).compile();

    service = module.get<AccountsService>(AccountsService);
  });

  describe('findAll', () => {
    it('returns all accounts', async () => {
      const accounts = [{ name: 'Checking', balance: 1000 }];
      mockModel.find.mockReturnValue(mkChain(accounts));
      expect(await service.findAll()).toEqual(accounts);
    });
  });

  describe('findOne', () => {
    it('returns account when found', async () => {
      const account = { _id: 'abc', name: 'Savings' };
      mockModel.findById.mockReturnValue(mkChain(account));
      expect(await service.findOne('abc')).toEqual(account);
    });

    it('throws NotFoundException when not found', async () => {
      mockModel.findById.mockReturnValue(mkChain(null));
      await expect(service.findOne('not-exist')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('calls model.create with the dto', async () => {
      const dto = { name: 'Wallet', balance: 500 };
      mockModel.create.mockResolvedValue({ ...dto, _id: 'new-id' });
      const result = await service.create(dto as any);
      expect(mockModel.create).toHaveBeenCalledWith(dto);
      expect(result).toMatchObject(dto);
    });
  });

  describe('update', () => {
    it('returns updated account', async () => {
      const existing = { _id: 'abc', name: 'Old' };
      const updated = { _id: 'abc', name: 'New' };
      mockModel.findById.mockReturnValue(mkChain(existing));
      mockModel.findByIdAndUpdate.mockReturnValue(mkChain(updated));
      expect(await service.update('abc', { name: 'New' } as any)).toEqual(updated);
    });

    it('throws when account does not exist', async () => {
      mockModel.findById.mockReturnValue(mkChain(null));
      await expect(service.update('bad', {} as any)).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes and returns the removed account', async () => {
      const account = { _id: 'abc', name: 'Old' };
      mockModel.findById.mockReturnValue(mkChain(account));
      mockModel.findByIdAndDelete.mockReturnValue(mkChain(account));
      expect(await service.remove('abc')).toEqual(account);
    });

    it('throws when account does not exist', async () => {
      mockModel.findById.mockReturnValue(mkChain(null));
      await expect(service.remove('bad')).rejects.toThrow(NotFoundException);
    });
  });

  describe('sumBalances', () => {
    it('sums balances of accounts with includeInTotal=true', async () => {
      mockModel.find.mockReturnValue(mkChain([
        { balance: 1000 },
        { balance: 500 },
      ]));
      expect(await service.sumBalances()).toBe(1500);
      expect(mockModel.find).toHaveBeenCalledWith({ includeInTotal: true });
    });

    it('returns 0 when no accounts match', async () => {
      mockModel.find.mockReturnValue(mkChain([]));
      expect(await service.sumBalances()).toBe(0);
    });
  });
});
