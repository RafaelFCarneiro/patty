import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as R from 'ramda';
import { Category, CategoryDocument } from './schemas/category.schema';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

const byType = (type?: string) => (cats: any[]) =>
  type ? R.filter(R.propEq(type, 'type'), cats) : cats;

@Injectable()
export class CategoriesService {
  constructor(@InjectModel(Category.name) private readonly model: Model<CategoryDocument>) {}

  findAll = async (type?: string) => {
    const all = await this.model.find().lean().exec();
    return byType(type)(all);
  };

  findOne = async (id: string) => {
    const doc = await this.model.findById(id).lean().exec();
    if (!doc) throw new NotFoundException(`Category ${id} not found`);
    return doc;
  };

  create = (dto: CreateCategoryDto) => this.model.create(dto);

  update = async (id: string, dto: UpdateCategoryDto) => {
    await this.findOne(id);
    return this.model.findByIdAndUpdate(id, dto, { new: true }).lean().exec();
  };

  remove = async (id: string) => {
    await this.findOne(id);
    return this.model.findByIdAndDelete(id).lean().exec();
  };
}
