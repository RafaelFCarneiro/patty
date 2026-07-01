import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import { guard, okOr } from '../common/result.js';
import { tagErrors, type Tag } from '../models/tag.js';
import type { Deps } from './deps.js';

export const listTags = (deps: Deps): Promise<Tag[]> => deps.tags.list();

const assertTagNameAvailable = async (deps: Deps, name: string): Promise<boolean> =>
  !(await deps.tags.findByName(name));

export const createTag = (deps: Deps, name: string): ResultAsync<Tag, AppError> =>
  safeTry(async function* () {
    yield* guard(await assertTagNameAvailable(deps, name), tagErrors.duplicateName(name));
    const tag = await deps.tags.create({ id: deps.newId(), name });
    return ok(yield* okOr(tag, tagErrors.duplicateName(name)));
  });

export const deleteTag = (deps: Deps, id: string): ResultAsync<{ deleted: boolean }, AppError> =>
  safeTry(async function* () {
    const deleted = await deps.tags.delete(id);
    return ok({ deleted });
  });
