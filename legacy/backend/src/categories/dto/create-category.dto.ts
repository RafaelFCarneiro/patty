export class CreateCategoryDto {
  name: string;
  type: string;
  icon?: string;
  color?: string;
  parentId?: string | null;
}
