import { Controller, Get, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('summary')
  summary(@Query('month') month?: string, @Query('year') year?: string) {
    return this.service.summary(Number(month), Number(year));
  }

  @Get('calendar')
  calendar(@Query('month') month?: string, @Query('year') year?: string) {
    return this.service.calendar(Number(month), Number(year));
  }
}
