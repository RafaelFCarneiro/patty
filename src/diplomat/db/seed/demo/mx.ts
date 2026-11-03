import { DemoCountry, DemoFunding, type DemoPack } from '../../../../models/demo/demo.js';
import { TOUR_FACTS } from '../../../../models/demo/tour.js';
import { Locale } from '../../../../models/locale.js';
import { CurrencyCode } from '../../../../models/money.js';
import { DefaultCategoryId } from '../categories.js';
import { BUDGET_SHAPES, fixedLine, pendingLine, SPANISH_TAGS, spendLine, tripItem } from './shared.js';

const C = DefaultCategoryId.enum;
const F = DemoFunding.enum;
const WORK = SPANISH_TAGS.work;
const FAMILY = SPANISH_TAGS.family;

/** Mexico: es, MXN — Nu México, BBVA México and Banorte, a trip to Oaxaca. */
export const MX_PACK: DemoPack = {
  country: DemoCountry.enum.mx,
  locale: Locale.enum.es,
  currency: CurrencyCode.enum.MXN,
  amountStep: 0.5,
  usdRate: 18.5,
  accounts: {
    checking: { name: 'BBVA México', initialBalance: 28000 },
    savings: { name: 'Nu México Cajita', initialBalance: 65000 },
    investment: { name: 'Banorte Inversión', initialBalance: 150000 },
    wallet: { name: 'Efectivo', initialBalance: 1500 },
    usdc: { name: 'USDC Cripto', initialBalance: 450 },
    btc: { name: 'BTC Cripto', initialBalance: 0.0185 },
  },
  cards: {
    primary: { name: 'Nu México Tarjeta', closingDay: 4, dueDay: 24, limit: 60000 },
    secondary: { name: 'Banorte Oro', closingDay: 21, dueDay: 8, limit: 80000 },
  },
  tags: [WORK, FAMILY],
  salary: fixedLine(C['cat-salary'], 'Nómina Empresa', 32000, 15),
  rent: fixedLine(C['cat-housing'], 'Renta', 9500, 3),
  subscriptions: [
    fixedLine(C['cat-subscriptions'], 'Netflix', 219, 12),
    fixedLine(C['cat-subscriptions'], 'Spotify', 129, 15),
    fixedLine(C['cat-health'], 'Gimnasio Smart Fit', 449, 8),
    fixedLine(C['cat-utilities'], 'Internet Telmex Infinitum', 499, 20),
  ],
  freelance: fixedLine(C['cat-extra-income'], 'Proyecto freelance', 7500, 18),
  spending: [
    spendLine(F.primaryCard, C['cat-food'], 'Soriana', [650, 1500], 2),
    spendLine(F.wallet, C['cat-food'], 'Oxxo', [40, 180], 4),
    spendLine(F.wallet, C['cat-food'], 'Mercado de Coyoacán', [150, 400], 2),
    spendLine(F.primaryCard, C['cat-food'], 'Rappi', [140, 380], 4),
    spendLine(F.wallet, C['cat-food'], 'Tacos El Califa', [120, 280], 2),
    spendLine(F.checking, C['cat-food'], 'Panadería La Esperanza', [60, 180], 2),
    spendLine(F.primaryCard, C['cat-food'], 'Comida con cliente', [350, 800], 1, WORK),
    spendLine(F.primaryCard, C['cat-transport'], 'DiDi', [55, 180], 5),
    spendLine(F.secondaryCard, C['cat-transport'], 'Uber', [70, 210], 2),
    spendLine(F.secondaryCard, C['cat-transport'], 'Gasolinera Pemex', [600, 900], 2),
    spendLine(F.wallet, C['cat-transport'], 'Estacionamiento', [40, 90], 1),
    spendLine(F.checking, C['cat-health'], 'Farmacias del Ahorro', [120, 600], 2),
    spendLine(F.checking, C['cat-health'], 'Consulta Dr. Hernández', [700, 700], 1),
    spendLine(F.primaryCard, C['cat-leisure'], 'Cinépolis', [120, 300], 1),
    spendLine(F.secondaryCard, C['cat-leisure'], 'Bar La Ópera', [350, 900], 2),
    spendLine(F.secondaryCard, C['cat-shopping'], 'Liverpool', [600, 2400], 1),
    spendLine(F.primaryCard, C['cat-shopping'], 'Mercado Libre', [300, 1500], 1),
    spendLine(F.secondaryCard, C['cat-shopping'], 'Amazon México', [250, 1800], 1),
    spendLine(F.secondaryCard, C['cat-shopping'], 'Regalo para la familia', [400, 1100], 1, FAMILY),
    spendLine(F.checking, C['cat-utilities'], 'Recibo de luz CFE', [400, 750], 1),
    spendLine(F.checking, C['cat-utilities'], 'Recibo de agua', [200, 350], 1),
    spendLine(F.checking, C['cat-education'], 'Curso de inglés', [1800, 1800], 1),
  ],
  transfers: {
    savings: { description: 'Ahorro mensual', amount: 4000 },
    investment: { description: 'Aportación a inversión', amount: 3000 },
    wallet: { description: 'Retiro para efectivo', amount: 1500 },
  },
  pending: [
    pendingLine(C['cat-housing'], 'Mantenimiento del edificio', 1400, 5),
    pendingLine(C['cat-transport'], 'Seguro del auto', 1100, 8),
    pendingLine(C['cat-extra-income'], 'Reembolso de gastos', 1800, 3, true),
  ],
  budgets: BUDGET_SHAPES,
  trip: {
    destination: TOUR_FACTS[DemoCountry.enum.mx].destination,
    items: [
      tripItem(0, F.primaryCard, C['cat-travel'], 'Vuelo Viva Aerobus a Oaxaca', 2450),
      tripItem(0, F.primaryCard, C['cat-travel'], 'Hotel Casa Oaxaca', 5200),
      tripItem(0, F.checking, C['cat-transport'], 'Taxi del aeropuerto de Oaxaca', 320),
      tripItem(1, F.secondaryCard, C['cat-food'], 'Cena en Casa Oaxaca restaurante', 1380),
      tripItem(1, F.secondaryCard, C['cat-transport'], 'Renta de auto Oaxaca', 1900),
      tripItem(2, F.secondaryCard, C['cat-leisure'], 'Tour a Hierve el Agua Oaxaca', 780),
      tripItem(3, F.wallet, C['cat-food'], 'Comida en el Mercado 20 de Noviembre Oaxaca', 420),
      tripItem(4, F.secondaryCard, C['cat-shopping'], 'Artesanías y mezcal Oaxaca', 1650),
      tripItem(4, F.primaryCard, C['cat-food'], 'Desayuno y mole en Oaxaca', 560),
      tripItem(5, F.checking, C['cat-transport'], 'Taxi al aeropuerto de Oaxaca', 340),
    ],
  },
};
