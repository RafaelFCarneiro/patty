import { SETTINGS_ENTITY_TAG, type SettingsEntity } from '../models/locale.js';
import * as persistence from '../logic/persistence.js';
import type { SettingsRow } from '../wire/db/settings.js';

/** Entity → row for the versioned unit of work — a `SettingsEntity` is already row-shaped once
 *  versioned (mirrors `adapters/tags.ts`). */
export const modelToDb = (entity: SettingsEntity): SettingsRow => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(SETTINGS_ENTITY_TAG, modelToDb);
