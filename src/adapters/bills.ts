import * as persistence from '../logic/persistence.js';
import { BILL_ENTITY_TAG, type BillEntity } from '../models/bill.js';

/** Entity → row for the versioned unit of work: the entity's fields are the row's columns. */
export const modelToDb = (entity: BillEntity & { version: number }): BillEntity & { version: number } => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(BILL_ENTITY_TAG, modelToDb);
