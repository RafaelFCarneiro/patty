import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Tag, TagDocument } from './schemas/tag.schema';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';

@Injectable()
export class TagsService {
  constructor(@InjectModel(Tag.name) private readonly model: Model<TagDocument>) {}

  findAll = () => this.model.find().sort({ name: 1 }).lean().exec();

  findOne = async (id: string) => {
    const doc = await this.model.findById(id).lean().exec();
    if (!doc) throw new NotFoundException(`Tag ${id} not found`);
    return doc;
  };

  create = (dto: CreateTagDto) => this.model.create(dto);

  update = async (id: string, dto: UpdateTagDto) => {
    await this.findOne(id);
    return this.model.findByIdAndUpdate(id, dto, { new: true }).lean().exec();
  };

  remove = async (id: string) => {
    await this.findOne(id);
    return this.model.findByIdAndDelete(id).lean().exec();
  };
}
