export class CreateGoalDto {
  name: string;
  targetAmount: number;
  currentAmount?: number;
  targetDate?: Date;
  icon?: string;
  color?: string;
}
