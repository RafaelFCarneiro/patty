export class CreateAccountDto {
  name: string;
  type?: string;
  balance?: number;
  icon?: string;
  color?: string;
  includeInTotal?: boolean;
  showOnDashboard?: boolean;
}
