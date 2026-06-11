import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TransactionDocument = Transaction & Document;

@Schema({ timestamps: true })
export class Transaction {
  @Prop({ required: true }) description: string;
  @Prop({ required: true, min: 0 }) amount: number;
  @Prop({ required: true, enum: ['income', 'expense'] }) type: string;
  @Prop({ required: true }) date: Date;
  @Prop({ type: Types.ObjectId, ref: 'Category', default: null }) categoryId: Types.ObjectId | null;
  @Prop({ type: Types.ObjectId, ref: 'Account', default: null }) accountId: Types.ObjectId | null;
  @Prop({ type: Types.ObjectId, ref: 'CreditCard', default: null }) creditCardId: Types.ObjectId | null;
  @Prop({ type: [Types.ObjectId], ref: 'Tag', default: [] }) tags: Types.ObjectId[];
  @Prop({ enum: ['paid', 'pending'], default: 'paid' }) status: string;
  @Prop({ default: '' }) notes: string;
  @Prop({ enum: ['none', 'monthly', 'weekly', 'yearly'], default: 'none' }) recurrence: string;
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);
