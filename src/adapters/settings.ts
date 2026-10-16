import { USER_SETTINGS_ENTITY_TAG, type UserSettingsEntity } from '../models/locale.js';
import * as persistence from '../logic/persistence.js';
import type { UserSettingsRow } from '../wire/db/settings.js';

export const modelToDb = (entity: UserSettingsEntity): UserSettingsRow => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(USER_SETTINGS_ENTITY_TAG, modelToDb);
