import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BudgetDocument = Budget & Document;

@Schema({ timestamps: true })
export class Budget {
  @Prop({ type: Types.ObjectId, ref: 'Category', required: true }) categoryId: Types.ObjectId;
  @Prop({ required: true, min: 1, max: 12 }) month: number;
  @Prop({ required: true }) year: number;
  @Prop({ required: true, min: 0 }) plannedAmount: number;
}

export const BudgetSchema = SchemaFactory.createForClass(Budget);
