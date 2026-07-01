#!/usr/bin/env node
/**
 * CI gate for the CLAUDE.md "Definition of Done": a change that touches behavior code must
 * ship test changes in the same change. Fails when behavior files changed but no test files did.
 *
 * Behavior = src/{logic,controllers,adapters} and src/diplomat/{db/repos,mcp,http}.
 * Tests = any *.test.ts or anything under test/.
 *
 * Range: <merge-base(BASE_REF, HEAD)>..HEAD. BASE_REF defaults to origin/main; CI passes the PR
 * base sha. Escape hatch for genuine no-behavior-change refactors: include the literal token
 * [no-behavior-change] in a commit message on the branch (a conscious, reviewable assertion).
 */
import { execSync } from 'node:child_process';

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

const baseRef = process.env.BASE_REF || 'origin/main';

const rangeFrom = () => {
  try {
    return sh(`git merge-base ${baseRef} HEAD`);
  } catch {
    return 'HEAD~1'; // shallow/detached fallback
  }
};

const range = `${rangeFrom()}..HEAD`;
const changed = sh(`git diff --name-only ${range}`).split('\n').filter(Boolean);

const BEHAVIOR = /^src\/(logic|controllers|adapters)\/|^src\/diplomat\/(db\/repos|mcp|http)\//;
const TEST = /\.test\.ts$|^test\//;

const behaviorFiles = changed.filter((f) => BEHAVIOR.test(f));
const hasTestChange = changed.some((f) => TEST.test(f));

if (behaviorFiles.length === 0) {
  console.log('check-tests-changed: no behavior files changed — ok');
  process.exit(0);
}
if (hasTestChange) {
  console.log(`check-tests-changed: ${behaviorFiles.length} behavior file(s) changed with test changes — ok`);
  process.exit(0);
}
if (/\[no-behavior-change\]/.test(sh(`git log --format=%B ${range}`))) {
  console.log('check-tests-changed: behavior files changed, [no-behavior-change] asserted — ok');
  process.exit(0);
}

console.error(
  [
    '',
    'check-tests-changed: FAIL — behavior code changed but no tests were added or updated.',
    '',
    'Behavior files in this change:',
    ...behaviorFiles.map((f) => `  - ${f}`),
    '',
    'Per CLAUDE.md "Definition of Done", any behavior change ships tests in the same change',
    '(success + expected-failure). Add or extend tests under test/unit or test/integration.',
    '',
    'If this change genuinely alters no behavior (pure refactor/rename), assert it by including',
    '[no-behavior-change] in a commit message on this branch.',
    '',
  ].join('\n'),
);
process.exit(1);
