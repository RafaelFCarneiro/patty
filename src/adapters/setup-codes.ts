import * as persistence from '../logic/persistence.js';
import { SETUP_CODE_ENTITY_TAG } from '../models/auth/entity.js';
import { type SetupCodeEntity, SetupCodeEntitySchema } from '../models/auth/owner.js';
import type { SetupCodeRow } from '../wire/db/setup-codes.js';

export const dbToModel = (row: SetupCodeRow): SetupCodeEntity => SetupCodeEntitySchema.parse(row);

/** A versioned `SetupCodeEntity` is already row-shaped. */
export const modelToDb = (entity: SetupCodeEntity): SetupCodeRow => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(SETUP_CODE_ENTITY_TAG, modelToDb);
