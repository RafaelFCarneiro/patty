import { DemoCountry } from './demo.js';
import type { InstanceKind } from './instance.js';
import type { Locale } from './locale.js';

/** One line of the tour's sample statement, `daysAgo` before today so it is always recent. */
export type TourStatementLine = { daysAgo: number; description: string; amount: number; income?: boolean };

export type TourFacts = {
  /** Where the seeded trip went: the tour's step 5 names it, and the country pack's trip uses the same word. */
  destination: string;
  statement: readonly TourStatementLine[];
};

/** Per country, in local terms: a known merchant or two (classified), an income, and one nobody can classify (so the
 *  import shows `needs_review`). */
export const TOUR_FACTS: Readonly<Record<DemoCountry, TourFacts>> = {
  [DemoCountry.enum.br]: {
    destination: 'Florianópolis',
    statement: [
      { daysAgo: 1, description: 'IFOOD *RESTAURANTE', amount: 54.9 },
      { daysAgo: 2, description: 'UBER *TRIP', amount: 23.4 },
      { daysAgo: 3, description: 'PIX RECEBIDO JOAO', amount: 150, income: true },
      { daysAgo: 4, description: 'PAGTO XPTO 8831', amount: 89 },
    ],
  },
  [DemoCountry.enum.us]: {
    destination: 'Denver',
    statement: [
      { daysAgo: 1, description: 'WHOLE FOODS MARKET', amount: 62.35 },
      { daysAgo: 2, description: 'LYFT *RIDE', amount: 18.2 },
      { daysAgo: 3, description: 'ZELLE FROM JOHN', amount: 120, income: true },
      { daysAgo: 4, description: 'POS DEBIT XPTO 8831', amount: 41 },
    ],
  },
  [DemoCountry.enum.mx]: {
    destination: 'Oaxaca',
    statement: [
      { daysAgo: 1, description: 'OXXO TIENDA', amount: 148.5 },
      { daysAgo: 2, description: 'DIDI VIAJE', amount: 96 },
      { daysAgo: 3, description: 'SPEI RECIBIDO JUAN', amount: 1200, income: true },
      { daysAgo: 4, description: 'COMPRA XPTO 8831', amount: 450 },
    ],
  },
  [DemoCountry.enum.co]: {
    destination: 'Cartagena',
    statement: [
      { daysAgo: 1, description: 'EXITO COMPRA', amount: 142000 },
      { daysAgo: 2, description: 'RAPPI PEDIDO', amount: 38500 },
      { daysAgo: 3, description: 'TRANSFERENCIA RECIBIDA JUAN', amount: 250000, income: true },
      { daysAgo: 4, description: 'COMPRA XPTO 8831', amount: 89000 },
    ],
  },
};

export type TourStatementDated = { date: string; description: string; amount: number; income: boolean };

/** What the `tour` prompt is built from. A standard database gets only the pointer to the demo. */
export type TourContext =
  | { kind: typeof InstanceKind.enum.standard; locale: Locale }
  | {
      kind: typeof InstanceKind.enum.demo;
      locale: Locale;
      destination: string;
      statement: readonly TourStatementDated[];
    };
