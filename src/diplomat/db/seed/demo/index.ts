import { DemoCountry, type DemoPack } from '../../../../models/demo/core.js';
import { BR_PACK } from './br.js';
import { CO_PACK } from './co.js';
import { MX_PACK } from './mx.js';
import { US_PACK } from './us.js';

/** One pack per country: the `Record` key type makes a missing country a compile error. */
export const DEMO_PACKS = {
  [DemoCountry.enum.br]: BR_PACK,
  [DemoCountry.enum.us]: US_PACK,
  [DemoCountry.enum.mx]: MX_PACK,
  [DemoCountry.enum.co]: CO_PACK,
} as const satisfies Record<DemoCountry, DemoPack>;
