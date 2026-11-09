/** Package identity, shared by every message that tells a person what to run. Every command PATTY prints or
 *  documents is `@latest`-pinned: without a version `npx` prefers an installed (possibly stale, global) copy over the
 *  registry's. Built from this one constant, never re-typed. */
export const PACKAGE_NAME = '@rfc0/patty';
export const PACKAGE_SPEC = `${PACKAGE_NAME}@latest`;
export const NPX_COMMAND = `npx ${PACKAGE_SPEC}`;
export const REPOSITORY_URL = 'https://github.com/RafaelFCarneiro/patty';
