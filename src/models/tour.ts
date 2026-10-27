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

const expenseLine = (daysAgo: number, description: string, amount: number): TourStatementLine => ({
  daysAgo,
  description,
  amount,
});

/** Per country, in local terms: a known merchant or two (classified), an income, and one nobody can classify (so the
 *  import shows `needs_review`). */
export const TOUR_FACTS = {
  [DemoCountry.enum.br]: {
    destination: 'Florianópolis',
    statement: [
      expenseLine(1, 'IFOOD *RESTAURANTE', 54.9),
      expenseLine(2, 'UBER *TRIP', 23.4),
      { daysAgo: 3, description: 'PIX RECEBIDO JOAO', amount: 150, income: true },
      expenseLine(4, 'PAGTO XPTO 8831', 89),
    ],
  },
  [DemoCountry.enum.us]: {
    destination: 'Denver',
    statement: [
      expenseLine(1, 'WHOLE FOODS MARKET', 62.35),
      expenseLine(2, 'LYFT *RIDE', 18.2),
      { daysAgo: 3, description: 'ZELLE FROM JOHN', amount: 120, income: true },
      expenseLine(4, 'POS DEBIT XPTO 8831', 41),
    ],
  },
  [DemoCountry.enum.mx]: {
    destination: 'Oaxaca',
    statement: [
      expenseLine(1, 'OXXO TIENDA', 148.5),
      expenseLine(2, 'DIDI VIAJE', 96),
      { daysAgo: 3, description: 'SPEI RECIBIDO JUAN', amount: 1200, income: true },
      expenseLine(4, 'COMPRA XPTO 8831', 450),
    ],
  },
  [DemoCountry.enum.co]: {
    destination: 'Cartagena',
    statement: [
      expenseLine(1, 'EXITO COMPRA', 142000),
      expenseLine(2, 'RAPPI PEDIDO', 38500),
      { daysAgo: 3, description: 'TRANSFERENCIA RECIBIDA JUAN', amount: 250000, income: true },
      expenseLine(4, 'COMPRA XPTO 8831', 89000),
    ],
  },
} as const satisfies Record<DemoCountry, TourFacts>;

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
