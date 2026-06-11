import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CreditCard, CreditCardSchema } from './schemas/credit-card.schema';
import { Bill, BillSchema } from './schemas/bill.schema';
import { CreditCardsController } from './credit-cards.controller';
import { CreditCardsService } from './credit-cards.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CreditCard.name, schema: CreditCardSchema },
      { name: Bill.name, schema: BillSchema },
    ]),
  ],
  controllers: [CreditCardsController],
  providers: [CreditCardsService],
  exports: [CreditCardsService],
})
export class CreditCardsModule {}
