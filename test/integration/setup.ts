import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

let tmpDir: string;

export const setup = (ctx: TestProject) => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-test-'));
  ctx.provide('DB_PATH' as never, join(tmpDir, 'test.db') as never);
};

export const teardown = () => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
};
