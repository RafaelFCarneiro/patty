import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CategoryDocument = Category & Document;

@Schema({ timestamps: true })
export class Category {
  @Prop({ required: true }) name: string;
  @Prop({ required: true, enum: ['income', 'expense'] }) type: string;
  @Prop({ default: 'tag' }) icon: string;
  @Prop({ default: '#6366f1' }) color: string;
  @Prop({ type: Types.ObjectId, ref: 'Category', default: null }) parentId: Types.ObjectId | null;
}

export const CategorySchema = SchemaFactory.createForClass(Category);
