import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { type Db, openDatabase } from '../../../src/diplomat/db/driver.js';
import { subCategoriesRepo } from '../../../src/diplomat/db/repos/sub-categories.js';
import { categories, users } from '../../../src/diplomat/db/schema.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';

const OTHER_USER_ID = 'user-other';

let tmpDir: string;
let db: Db;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-subcategories-repo-'));
  db = await openDatabase({ DB_PATH: join(tmpDir, 'subcategories.db'), FINTRACK_DB_KEY: 'a'.repeat(64) });
  await bootstrap(db);
  await db
    .insert(users)
    .values({ id: OTHER_USER_ID, username: 'other', passwordHash: 'x', role: 'member', createdAt: '2026-01-01' });
  await db.insert(categories).values([
    { id: 'own-parent', name: 'Own parent', kind: 'expense', userId: OWNER_USER_ID },
    { id: 'own-sub', name: 'Own sub', kind: 'expense', parentId: 'own-parent', userId: OWNER_USER_ID },
    { id: 'other-parent', name: 'Other parent', kind: 'expense', userId: OTHER_USER_ID },
    { id: 'other-sub', name: 'Other sub', kind: 'expense', parentId: 'other-parent', userId: OTHER_USER_ID },
  ]);
});

afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

describe('subCategoriesRepo.findByName', () => {
  it("finds the user's own sub-category, with its parent's name and kind", async () => {
    const found = await subCategoriesRepo(db, OWNER_USER_ID).findByName('Own sub');

    expect(found).toMatchObject({ id: 'own-sub', name: 'Own sub', parentId: 'own-parent', parentName: 'Own parent' });
  });

  it('finds nothing for a name no visible sub-category has, matching the name exactly', async () => {
    const repo = subCategoriesRepo(db, OWNER_USER_ID);

    expect(await repo.findByName('Nope')).toBeNull();
    expect(await repo.findByName('own sub')).toBeNull();
    expect(await repo.findByName('Own parent')).toBeNull();
  });

  it("never sees another user's sub-category, though that user does", async () => {
    expect(await subCategoriesRepo(db, OWNER_USER_ID).findByName('Other sub')).toBeNull();
    expect(await subCategoriesRepo(db, OTHER_USER_ID).findByName('Other sub')).toMatchObject({ id: 'other-sub' });
  });
});
