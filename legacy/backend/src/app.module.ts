import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccountsModule } from './accounts/accounts.module';
import { TransactionsModule } from './transactions/transactions.module';
import { CategoriesModule } from './categories/categories.module';
import { TagsModule } from './tags/tags.module';
import { CreditCardsModule } from './credit-cards/credit-cards.module';
import { BudgetsModule } from './budgets/budgets.module';
import { GoalsModule } from './goals/goals.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [
    MongooseModule.forRoot('mongodb://localhost:27017/fintrack'),
    AccountsModule,
    TransactionsModule,
    CategoriesModule,
    TagsModule,
    CreditCardsModule,
    BudgetsModule,
    GoalsModule,
    DashboardModule,
    ReportsModule,
  ],
})
export class AppModule {}
