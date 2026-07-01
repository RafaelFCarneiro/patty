#!/usr/bin/env node
// Merges coverage-final.json files from coverage/.tmp/* into a single HTML + text report.
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const { createCoverageMap } = libCoverage;
const { createContext } = libReport;
const { create } = reports;
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const tmpDir = 'coverage/.tmp';
const outDir = 'coverage';

const map = createCoverageMap({});

for (const entry of readdirSync(tmpDir)) {
  const jsonPath = join(tmpDir, entry, 'coverage-final.json');
  try {
    statSync(jsonPath);
    map.merge(JSON.parse(readFileSync(jsonPath, 'utf8')));
    console.log(`merged: ${jsonPath}`);
  } catch {
    // skip entries without a coverage-final.json
  }
}

const ctx = createContext({ dir: outDir, coverageMap: map });
create('text').execute(ctx);
create('html').execute(ctx);
console.log(`\nFull report: ${outDir}/index.html`);
