import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as R from 'ramda';
import { Account, AccountDocument } from './schemas/account.schema';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

const toPlain = (doc: AccountDocument) => doc.toObject({ virtuals: true });

@Injectable()
export class AccountsService {
  constructor(@InjectModel(Account.name) private readonly model: Model<AccountDocument>) {}

  findAll = () => this.model.find().lean().exec();

  findOne = async (id: string) => {
    const doc = await this.model.findById(id).lean().exec();
    if (!doc) throw new NotFoundException(`Account ${id} not found`);
    return doc;
  };

  create = (dto: CreateAccountDto) => this.model.create(dto);

  update = async (id: string, dto: UpdateAccountDto) => {
    await this.findOne(id);
    return this.model.findByIdAndUpdate(id, dto, { new: true }).lean().exec();
  };

  remove = async (id: string) => {
    await this.findOne(id);
    return this.model.findByIdAndDelete(id).lean().exec();
  };

  sumBalances = async () => {
    const accounts = await this.model.find({ includeInTotal: true }).lean().exec();
    return R.sum(R.pluck('balance', accounts));
  };
}
