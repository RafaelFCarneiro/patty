import * as persistence from '../logic/persistence.js';
import { ACCESS_TOKEN_ENTITY_TAG } from '../models/auth/entity.js';
import { type AccessTokenEntity, AccessTokenEntitySchema } from '../models/auth/token.js';
import type { AccessTokenRow } from '../wire/db/accessTokens.js';

export const dbToModel = (row: AccessTokenRow): AccessTokenEntity => AccessTokenEntitySchema.parse(row);

/** A versioned `AccessTokenEntity` is already row-shaped (`scopes` is a JSON column the driver (de)serializes). */
export const modelToDb = (entity: AccessTokenEntity): AccessTokenRow => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(ACCESS_TOKEN_ENTITY_TAG, modelToDb);
