import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as R from 'ramda';
import { CreditCard, CreditCardDocument } from './schemas/credit-card.schema';
import { Bill, BillDocument } from './schemas/bill.schema';
import { CreateCreditCardDto } from './dto/create-credit-card.dto';
import { UpdateCreditCardDto } from './dto/update-credit-card.dto';

@Injectable()
export class CreditCardsService {
  constructor(
    @InjectModel(CreditCard.name) private readonly cardModel: Model<CreditCardDocument>,
    @InjectModel(Bill.name) private readonly billModel: Model<BillDocument>,
  ) {}

  findAll = () => this.cardModel.find().lean().exec();

  findOne = async (id: string) => {
    const doc = await this.cardModel.findById(id).lean().exec();
    if (!doc) throw new NotFoundException(`Credit card ${id} not found`);
    return doc;
  };

  create = (dto: CreateCreditCardDto) => this.cardModel.create(dto);

  update = async (id: string, dto: UpdateCreditCardDto) => {
    await this.findOne(id);
    return this.cardModel.findByIdAndUpdate(id, dto, { new: true }).lean().exec();
  };

  remove = async (id: string) => {
    await this.findOne(id);
    return this.cardModel.findByIdAndDelete(id).lean().exec();
  };

  findBills = (creditCardId: string) =>
    this.billModel.find({ creditCardId }).sort({ year: -1, month: -1 }).lean().exec();

  findOrCreateBill = async (creditCardId: string, month: number, year: number) => {
    const existing = await this.billModel.findOne({ creditCardId, month, year }).lean().exec();
    if (existing) return existing;
    return this.billModel.create({ creditCardId, month, year });
  };

  payBill = async (billId: string, amount?: number) => {
    const bill = await this.billModel.findById(billId).lean().exec();
    if (!bill) throw new NotFoundException(`Bill ${billId} not found`);
    return this.billModel.findByIdAndUpdate(
      billId,
      { status: 'paid', paidAt: new Date(), paidAmount: amount ?? bill.paidAmount },
      { new: true },
    ).lean().exec();
  };

  totalUsed = async (creditCardId: string, month: number, year: number) => {
    const bills = await this.billModel.find({ creditCardId, month, year }).lean().exec();
    return R.sum(R.pluck('paidAmount', bills));
  };
}
