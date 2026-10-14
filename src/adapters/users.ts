import * as persistence from '../logic/persistence.js';
import { USER_ENTITY_TAG } from '../models/auth/entity.js';
import { type UserEntity, UserEntitySchema } from '../models/auth/owner.js';
import type { UserRow } from '../wire/db/users.js';

export const dbToModel = (row: UserRow): UserEntity => UserEntitySchema.parse(row);

/** A versioned `UserEntity` is already row-shaped. */
export const modelToDb = (entity: UserEntity): UserRow => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(USER_ENTITY_TAG, modelToDb);
