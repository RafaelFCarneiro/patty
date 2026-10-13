import * as persistence from '../logic/persistence.js';
import { SESSION_ENTITY_TAG } from '../models/auth/entity.js';
import { type SessionEntity, SessionEntitySchema } from '../models/auth/session.js';
import type { SessionRow } from '../wire/db/sessions.js';

export const dbToModel = (row: SessionRow): SessionEntity => SessionEntitySchema.parse(row);

/** A versioned `SessionEntity` is already row-shaped. */
export const modelToDb = (entity: SessionEntity): SessionRow => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(SESSION_ENTITY_TAG, modelToDb);
