import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CreditCardDocument = CreditCard & Document;

@Schema({ timestamps: true })
export class CreditCard {
  @Prop({ required: true }) name: string;
  @Prop({ required: true, min: 0 }) limit: number;
  @Prop({ required: true, min: 1, max: 31 }) closingDay: number;
  @Prop({ required: true, min: 1, max: 31 }) dueDay: number;
  @Prop({ default: '#06b6d4' }) color: string;
  @Prop({ default: 'credit-card' }) icon: string;
}

export const CreditCardSchema = SchemaFactory.createForClass(CreditCard);
