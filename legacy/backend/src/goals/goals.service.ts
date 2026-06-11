import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Goal, GoalDocument } from './schemas/goal.schema';
import { CreateGoalDto } from './dto/create-goal.dto';
import { UpdateGoalDto } from './dto/update-goal.dto';

@Injectable()
export class GoalsService {
  constructor(@InjectModel(Goal.name) private readonly model: Model<GoalDocument>) {}

  findAll = (status?: string) => this.model.find(status ? { status } : {}).lean().exec();

  findOne = async (id: string) => {
    const doc = await this.model.findById(id).lean().exec();
    if (!doc) throw new NotFoundException(`Goal ${id} not found`);
    return doc;
  };

  create = (dto: CreateGoalDto) => this.model.create(dto);

  update = async (id: string, dto: UpdateGoalDto) => {
    await this.findOne(id);
    return this.model.findByIdAndUpdate(id, dto, { new: true }).lean().exec();
  };

  remove = async (id: string) => {
    await this.findOne(id);
    return this.model.findByIdAndDelete(id).lean().exec();
  };
}
