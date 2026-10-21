import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** This build's version, from the package it was published as (`0.0.0-development` from a checkout). `src/common`
 *  and `dist/common` both sit two levels below the package root. */
export const { version } = require('../../package.json') as { version: string };
