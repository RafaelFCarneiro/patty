import * as persistence from '../logic/persistence.js';
import { INVITE_ENTITY_TAG } from '../models/auth/entity.js';
import { type InviteEntity, InviteEntitySchema } from '../models/auth/users.js';
import type { InviteRow } from '../wire/db/invites.js';

export const dbToModel = (row: InviteRow): InviteEntity => InviteEntitySchema.parse(row);

/** A versioned `InviteEntity` is already row-shaped. */
export const modelToDb = (entity: InviteEntity): InviteRow => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(INVITE_ENTITY_TAG, modelToDb);
