import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { CreditCardsService } from './credit-cards.service';
import { CreateCreditCardDto } from './dto/create-credit-card.dto';
import { UpdateCreditCardDto } from './dto/update-credit-card.dto';

@Controller('credit-cards')
export class CreditCardsController {
  constructor(private readonly service: CreditCardsService) {}

  @Get()
  findAll() { return this.service.findAll(); }

  @Get(':id')
  findOne(@Param('id') id: string) { return this.service.findOne(id); }

  @Post()
  create(@Body() dto: CreateCreditCardDto) { return this.service.create(dto); }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCreditCardDto) { return this.service.update(id, dto); }

  @Delete(':id')
  remove(@Param('id') id: string) { return this.service.remove(id); }

  @Get(':id/bills')
  findBills(@Param('id') id: string) { return this.service.findBills(id); }

  @Post('bills/:id/pay')
  payBill(@Param('id') id: string, @Body() body: { amount?: number }) { return this.service.payBill(id, body?.amount); }
}
