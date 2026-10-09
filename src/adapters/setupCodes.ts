import * as persistence from '../logic/persistence.js';
import { SETUP_CODE_ENTITY_TAG, SetupCodeEntitySchema, type SetupCodeEntity } from '../models/auth.js';
import type { SetupCodeRow } from '../wire/db/setupCodes.js';

export const dbToModel = (row: SetupCodeRow): SetupCodeEntity => SetupCodeEntitySchema.parse(row);

/** A versioned `SetupCodeEntity` is already row-shaped. */
export const modelToDb = (entity: SetupCodeEntity): SetupCodeRow => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(SETUP_CODE_ENTITY_TAG, modelToDb);
