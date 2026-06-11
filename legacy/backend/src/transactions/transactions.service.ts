import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as R from 'ramda';
import { Transaction, TransactionDocument } from './schemas/transaction.schema';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';

interface FindAllQuery {
  month?: number;
  year?: number;
  type?: string;
  accountId?: string;
  categoryId?: string;
  status?: string;
}

const buildDateRange = (month: number, year: number) => {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return { $gte: start, $lte: end };
};

const buildFilter = (q: FindAllQuery): Record<string, any> =>
  R.reject(R.isNil)({
    ...(q.month && q.year ? { date: buildDateRange(Number(q.month), Number(q.year)) } : {}),
    ...(q.type ? { type: q.type } : {}),
    ...(q.accountId ? { accountId: q.accountId } : {}),
    ...(q.categoryId ? { categoryId: q.categoryId } : {}),
    ...(q.status ? { status: q.status } : {}),
  });

@Injectable()
export class TransactionsService {
  constructor(@InjectModel(Transaction.name) private readonly model: Model<TransactionDocument>) {}

  findAll = (query: FindAllQuery) =>
    this.model
      .find(buildFilter(query))
      .populate('categoryId')
      .populate('accountId')
      .populate('creditCardId')
      .populate('tags')
      .sort({ date: -1 })
      .lean()
      .exec();

  findOne = async (id: string) => {
    const doc = await this.model
      .findById(id)
      .populate('categoryId')
      .populate('accountId')
      .populate('creditCardId')
      .populate('tags')
      .lean()
      .exec();
    if (!doc) throw new NotFoundException(`Transaction ${id} not found`);
    return doc;
  };

  findRaw = (filter: Record<string, any>) =>
    this.model.find(filter).lean().exec();

  create = (dto: CreateTransactionDto) => this.model.create(dto);

  update = async (id: string, dto: UpdateTransactionDto) => {
    await this.findOne(id);
    return this.model.findByIdAndUpdate(id, dto, { new: true }).lean().exec();
  };

  remove = async (id: string) => {
    await this.findOne(id);
    return this.model.findByIdAndDelete(id).lean().exec();
  };

  sumByType = async (type: string, month: number, year: number) => {
    const txs = await this.findRaw({ type, date: buildDateRange(month, year) });
    return R.sum(R.pluck('amount', txs));
  };

  pendingSum = async (type: string, month: number, year: number) => {
    const txs = await this.findRaw({ type, status: 'pending', date: buildDateRange(month, year) });
    return R.sum(R.pluck('amount', txs));
  };

  groupByDate = async (month: number, year: number) => {
    const txs = await this.findRaw({ date: buildDateRange(month, year) });
    return R.groupBy((t: any) => t.date.toISOString().slice(0, 10), txs);
  };

  groupByCategory = async (type: string, month: number, year: number) => {
    const txs = await this.model
      .find({ type, date: buildDateRange(month, year) })
      .populate('categoryId')
      .lean()
      .exec();
    const grouped = R.groupBy((t: any) => t.categoryId?._id?.toString() ?? 'uncategorized', txs);
    return Object.entries(grouped).map(([catId, items]) => ({
      category: items?.[0] ? (items[0] as any).categoryId ?? { name: 'Sem categoria', _id: catId } : { name: 'Sem categoria', _id: catId },
      total: items ? R.sum(R.pluck('amount', items as any[])) : 0,
    }));
  };
}
