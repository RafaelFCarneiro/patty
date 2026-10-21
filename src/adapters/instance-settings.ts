import * as persistence from '../logic/persistence.js';
import { INSTANCE_SETTINGS_ENTITY_TAG } from '../models/auth/entity.js';
import { type InstanceSettingsEntity, InstanceSettingsEntitySchema } from '../models/auth/users.js';
import type { InstanceSettingsRow } from '../wire/db/instance-settings.js';

export const dbToModel = (row: InstanceSettingsRow): InstanceSettingsEntity => InstanceSettingsEntitySchema.parse(row);

/** A versioned `InstanceSettingsEntity` is already row-shaped. */
export const modelToDb = (entity: InstanceSettingsEntity): InstanceSettingsRow => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(INSTANCE_SETTINGS_ENTITY_TAG, modelToDb);
