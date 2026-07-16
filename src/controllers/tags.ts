import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import { guard } from '../common/result.js';
import * as persistence from '../logic/persistence.js';
import type { FlowOutcome } from '../models/persistable.js';
import { tagErrors, TAG_ENTITY_TAG, type Tag } from '../models/tag.js';
import type { Deps } from './deps.js';

export const listTags = (deps: Deps): Promise<Tag[]> => deps.tags.list();

const assertTagNameAvailable = async (deps: Deps, name: string): Promise<boolean> =>
  !(await deps.tags.findByName(name));

export const createTag = (deps: Deps, name: string): ResultAsync<FlowOutcome<Tag>, AppError> =>
  safeTry(async function* () {
    yield* guard(await assertTagNameAvailable(deps, name), tagErrors.duplicateName(name));
    const tag: Tag = { id: deps.newId(), name };
    const persist = [persistence.insert({ entity: TAG_ENTITY_TAG, model: tag })];
    return ok({ persist, response: tag });
  });

/** Delete by id is idempotent-by-design (no name resolution, no ambiguity) — a missing tag
 *  returns `{ deleted: false }` rather than an error, unchanged from the pre-ADR-021 behavior
 *  (`deps.tags.delete`'s own `rowsAffected > 0` check). An empty `persist` batch mirrors
 *  `deleteAccountTransaction`'s dry-run shape: no write, response-only. */
export const deleteTag = (deps: Deps, id: string): ResultAsync<FlowOutcome<{ deleted: boolean }>, AppError> =>
  safeTry(async function* () {
    const tag = await deps.tags.findById(id);
    if (!tag) return ok({ persist: [], response: { deleted: false } });

    const persist = [persistence.remove({ entity: TAG_ENTITY_TAG, id: tag.id, version: tag.version })];
    return ok({ persist, response: { deleted: true } });
  });
