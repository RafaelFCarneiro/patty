import { Module } from '@nestjs/common';
import { TransactionsModule } from '../transactions/transactions.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [TransactionsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
