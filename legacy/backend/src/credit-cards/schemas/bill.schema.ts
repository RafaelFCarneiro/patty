import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BillDocument = Bill & Document;

@Schema({ timestamps: true })
export class Bill {
  @Prop({ type: Types.ObjectId, ref: 'CreditCard', required: true }) creditCardId: Types.ObjectId;
  @Prop({ required: true, min: 1, max: 12 }) month: number;
  @Prop({ required: true }) year: number;
  @Prop({ enum: ['open', 'closed', 'paid'], default: 'open' }) status: string;
  @Prop({ type: Date, default: null }) paidAt: Date | null;
  @Prop({ default: 0 }) paidAmount: number;
}

export const BillSchema = SchemaFactory.createForClass(Bill);
