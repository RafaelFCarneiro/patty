import { Controller, Get, Query } from '@nestjs/common';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get('expenses-by-category')
  expensesByCategory(@Query('month') month?: string, @Query('year') year?: string) {
    return this.service.expensesByCategory(Number(month), Number(year));
  }

  @Get('income-by-category')
  incomeByCategory(@Query('month') month?: string, @Query('year') year?: string) {
    return this.service.incomeByCategory(Number(month), Number(year));
  }

  @Get('monthly-balance')
  monthlyBalance(@Query('year') year?: string) {
    return this.service.monthlyBalance(Number(year));
  }

  @Get('performance')
  performance(@Query('month') month?: string, @Query('year') year?: string) {
    return this.service.performance(Number(month), Number(year));
  }
}
