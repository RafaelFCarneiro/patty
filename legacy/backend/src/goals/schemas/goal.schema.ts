import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type GoalDocument = Goal & Document;

@Schema({ timestamps: true })
export class Goal {
  @Prop({ required: true }) name: string;
  @Prop({ required: true, min: 0 }) targetAmount: number;
  @Prop({ default: 0 }) currentAmount: number;
  @Prop({ type: Date, default: null }) targetDate: Date | null;
  @Prop({ enum: ['active', 'completed'], default: 'active' }) status: string;
  @Prop({ default: 'target' }) icon: string;
  @Prop({ default: '#6366f1' }) color: string;
}

export const GoalSchema = SchemaFactory.createForClass(Goal);
