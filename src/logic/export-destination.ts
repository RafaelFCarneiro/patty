import { isAbsolute, relative, sep } from 'node:path';

const PARENT = '..';

/** Both arguments are real, absolute paths (symlinks already resolved by the shell): `path` is only string math. */
const isWithin = (container: string, directory: string): boolean => {
  const way = relative(container, directory);
  const leavesContainer = way === PARENT || way.startsWith(`${PARENT}${sep}`);
  return way === '' || (!leavesContainer && !isAbsolute(way));
};

/** A key must never sit next to the data it unlocks: not in the database's directory, nor under it. */
export const isBesideData = (dataDirectory: string, destinationDirectory: string): boolean =>
  isWithin(dataDirectory, destinationDirectory);

/** A snapshot must never be aimed at the live database itself. */
export const isDatabaseFile = (databaseFile: string, destination: string): boolean => databaseFile === destination;
