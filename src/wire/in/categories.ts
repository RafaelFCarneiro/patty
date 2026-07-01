import { z } from 'zod';
import * as modelCategory from '../../models/category.js';

// The boundary owns quality-of-life defaults; the domain keeps these fields required (not-null).
// Default kind is the most common category usage.
export const CreateCategorySchema = modelCategory.CreateCategorySchema.extend({
  kind: modelCategory.CreateCategorySchema.shape.kind.default(modelCategory.CategoryKind.enum.expense),
});
export type CreateCategory = z.infer<typeof CreateCategorySchema>;

export const CreateSubCategorySchema = modelCategory.CreateSubCategorySchema.omit({ id: true });
export type CreateSubCategory = z.infer<typeof CreateSubCategorySchema>;

export const SubCategoriesQuerySchema = z.object({ parentId: z.string().optional() });
export type SubCategoriesQuery = z.infer<typeof SubCategoriesQuerySchema>;
