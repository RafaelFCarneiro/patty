import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { CreditCardsModule } from '../credit-cards/credit-cards.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [AccountsModule, TransactionsModule, CreditCardsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
