import { CreateAccountDto } from './create-account.dto';
export class UpdateAccountDto implements Partial<CreateAccountDto> {
  name?: string;
  type?: string;
  balance?: number;
  icon?: string;
  color?: string;
  includeInTotal?: boolean;
  showOnDashboard?: boolean;
}
