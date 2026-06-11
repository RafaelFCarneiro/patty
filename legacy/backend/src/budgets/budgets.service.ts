import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Budget, BudgetDocument } from './schemas/budget.schema';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';

@Injectable()
export class BudgetsService {
  constructor(@InjectModel(Budget.name) private readonly model: Model<BudgetDocument>) {}

  findAll = (month?: number, year?: number) => {
    const filter: any = {};
    if (month) filter.month = Number(month);
    if (year) filter.year = Number(year);
    return this.model.find(filter).populate('categoryId').lean().exec();
  };

  findOne = async (id: string) => {
    const doc = await this.model.findById(id).populate('categoryId').lean().exec();
    if (!doc) throw new NotFoundException(`Budget ${id} not found`);
    return doc;
  };

  create = (dto: CreateBudgetDto) => this.model.create(dto);

  update = async (id: string, dto: UpdateBudgetDto) => {
    await this.findOne(id);
    return this.model.findByIdAndUpdate(id, dto, { new: true }).lean().exec();
  };

  remove = async (id: string) => {
    await this.findOne(id);
    return this.model.findByIdAndDelete(id).lean().exec();
  };
}
