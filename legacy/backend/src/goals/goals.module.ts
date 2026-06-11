import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Goal, GoalSchema } from './schemas/goal.schema';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: Goal.name, schema: GoalSchema }])],
  controllers: [GoalsController],
  providers: [GoalsService],
  exports: [GoalsService],
})
export class GoalsModule {}
