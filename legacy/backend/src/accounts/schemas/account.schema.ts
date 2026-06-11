import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AccountDocument = Account & Document;

@Schema({ timestamps: true })
export class Account {
  @Prop({ required: true }) name: string;
  @Prop({ enum: ['checking','savings','investment','wallet','other'], default: 'checking' }) type: string;
  @Prop({ default: 0 }) balance: number;
  @Prop({ default: 'bank' }) icon: string;
  @Prop({ default: '#6366f1' }) color: string;
  @Prop({ default: true }) includeInTotal: boolean;
  @Prop({ default: true }) showOnDashboard: boolean;
}

export const AccountSchema = SchemaFactory.createForClass(Account);
