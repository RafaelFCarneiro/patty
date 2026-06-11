export class CreateCreditCardDto {
  name: string;
  limit: number;
  closingDay: number;
  dueDay: number;
  color?: string;
  icon?: string;
}
