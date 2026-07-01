import { TagSchema, type Tag } from '../models/tag.js';
import type { TagRow } from '../wire/db/tags.js';

export const dbToModel = (row: TagRow): Tag => TagSchema.parse({ id: row.id, name: row.name });
