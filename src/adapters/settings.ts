import { USER_SETTINGS_ENTITY_TAG, type UserSettingsEntity } from '../models/locale.js';
import * as persistence from '../logic/persistence.js';
import type { UserSettingsRow } from '../wire/db/settings.js';

// Identity: a versioned UserSettingsEntity is already row-shaped (the owner is the applier's to add).
export const modelToDb = (entity: UserSettingsEntity): UserSettingsRow => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(USER_SETTINGS_ENTITY_TAG, modelToDb);
