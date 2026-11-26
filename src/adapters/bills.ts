import * as persistence from '../logic/persistence.js';
import { BILL_ENTITY_TAG, type BillEntity } from '../models/bill.js';

export const modelToDb = (entity: BillEntity & { version: number }): BillEntity & { version: number } => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(BILL_ENTITY_TAG, modelToDb);
