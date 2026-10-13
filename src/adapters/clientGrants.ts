import * as persistence from '../logic/persistence.js';
import { CLIENT_GRANT_ENTITY_TAG, ClientGrantEntitySchema, type ClientGrantEntity } from '../models/auth.js';
import type { ClientGrantRow } from '../wire/db/clientGrants.js';

export const dbToModel = (row: ClientGrantRow): ClientGrantEntity => ClientGrantEntitySchema.parse(row);

/** A versioned `ClientGrantEntity` is already row-shaped (`scopes` is a JSON column the driver (de)serializes). */
export const modelToDb = (entity: ClientGrantEntity): ClientGrantRow => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(CLIENT_GRANT_ENTITY_TAG, modelToDb);
