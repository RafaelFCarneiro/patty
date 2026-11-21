import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Result } from 'neverthrow';
import * as R from 'remeda';

// The throwing system calls, wrapped once: everything that uses them is Results.
export const readText = Result.fromThrowable((path: string) => readFileSync(path, 'utf8'), R.identity());
export const writeText = Result.fromThrowable((path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}, R.identity());
