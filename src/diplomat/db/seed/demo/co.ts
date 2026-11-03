import { DemoCountry, DemoFunding, type DemoPack } from '../../../../models/demo/core.js';
import { TOUR_FACTS } from '../../../../models/demo/tour.js';
import { Locale } from '../../../../models/locale.js';
import { CurrencyCode } from '../../../../models/money.js';
import { DefaultCategoryId } from '../categories.js';
import { BUDGET_SHAPES, fixedLine, pendingLine, SPANISH_TAGS, spendLine, tripItem } from './shared.js';

const C = DefaultCategoryId.enum;
const F = DemoFunding.enum;
const WORK = SPANISH_TAGS.work;
const FAMILY = SPANISH_TAGS.family;

/** Colombia: es, COP — Nu Colombia, Bancolombia and Davivienda, a trip to Cartagena. */
export const CO_PACK: DemoPack = {
  country: DemoCountry.enum.co,
  locale: Locale.enum.es,
  currency: CurrencyCode.enum.COP,
  amountStep: 100,
  usdRate: 4100,
  accounts: {
    checking: { name: 'Bancolombia', initialBalance: 6500000 },
    savings: { name: 'Nu Colombia Cajita', initialBalance: 9500000 },
    investment: { name: 'Davivienda Inversión', initialBalance: 28000000 },
    wallet: { name: 'Efectivo', initialBalance: 250000 },
    usdc: { name: 'USDC Cripto', initialBalance: 450 },
    btc: { name: 'BTC Cripto', initialBalance: 0.0185 },
  },
  cards: {
    primary: { name: 'Nu Colombia Tarjeta', closingDay: 5, dueDay: 25, limit: 9000000 },
    secondary: { name: 'Davivienda Visa', closingDay: 20, dueDay: 8, limit: 12000000 },
  },
  tags: [WORK, FAMILY],
  salary: fixedLine(C['cat-salary'], 'Nómina Empresa', 6800000, 28),
  rent: fixedLine(C['cat-housing'], 'Arriendo', 1900000, 3),
  subscriptions: [
    fixedLine(C['cat-subscriptions'], 'Netflix', 26900, 12),
    fixedLine(C['cat-subscriptions'], 'Spotify', 16900, 15),
    fixedLine(C['cat-health'], 'Gimnasio Bodytech', 129900, 8),
    fixedLine(C['cat-utilities'], 'Internet Claro Hogar', 99900, 20),
  ],
  freelance: fixedLine(C['cat-extra-income'], 'Proyecto freelance', 1500000, 18),
  spending: [
    spendLine(F.primaryCard, C['cat-food'], 'Éxito', [140000, 330000], 2),
    spendLine(F.checking, C['cat-food'], 'Carulla', [90000, 220000], 1),
    spendLine(F.wallet, C['cat-food'], 'Plaza de mercado', [40000, 90000], 2),
    spendLine(F.primaryCard, C['cat-food'], 'Rappi', [28000, 75000], 4),
    spendLine(F.secondaryCard, C['cat-food'], 'Restaurante Andrés Carne de Res', [120000, 260000], 1),
    spendLine(F.wallet, C['cat-food'], 'Panadería', [8000, 22000], 3),
    spendLine(F.primaryCard, C['cat-food'], 'Almuerzo con cliente', [70000, 150000], 1, WORK),
    spendLine(F.primaryCard, C['cat-transport'], 'DiDi', [9000, 32000], 5),
    spendLine(F.secondaryCard, C['cat-transport'], 'Uber', [12000, 38000], 2),
    spendLine(F.secondaryCard, C['cat-transport'], 'Estación de servicio Terpel', [130000, 190000], 1),
    spendLine(F.wallet, C['cat-transport'], 'Parqueadero', [6000, 16000], 2),
    spendLine(F.checking, C['cat-health'], 'Droguería Cruz Verde', [25000, 140000], 2),
    spendLine(F.checking, C['cat-health'], 'Consulta Dr. Ramírez', [160000, 160000], 1),
    spendLine(F.primaryCard, C['cat-leisure'], 'Cine Colombia', [22000, 60000], 1),
    spendLine(F.secondaryCard, C['cat-leisure'], 'Bar Theatron', [70000, 180000], 2),
    spendLine(F.secondaryCard, C['cat-shopping'], 'Falabella', [90000, 420000], 1),
    spendLine(F.primaryCard, C['cat-shopping'], 'Mercado Libre', [60000, 350000], 1),
    spendLine(F.secondaryCard, C['cat-shopping'], 'Regalo para la familia', [80000, 220000], 1, FAMILY),
    spendLine(F.checking, C['cat-utilities'], 'Recibo de energía Enel', [120000, 210000], 1),
    spendLine(F.checking, C['cat-utilities'], 'Acueducto', [60000, 110000], 1),
    spendLine(F.checking, C['cat-education'], 'Curso de inglés', [320000, 320000], 1),
  ],
  transfers: {
    savings: { description: 'Ahorro mensual', amount: 800000 },
    investment: { description: 'Aporte a inversión', amount: 600000 },
    wallet: { description: 'Retiro para efectivo', amount: 250000 },
  },
  pending: [
    pendingLine(C['cat-housing'], 'Administración del edificio', 320000, 5),
    pendingLine(C['cat-transport'], 'Seguro del carro', 280000, 9),
    pendingLine(C['cat-extra-income'], 'Reembolso de gastos', 380000, 3, true),
  ],
  budgets: BUDGET_SHAPES,
  trip: {
    destination: TOUR_FACTS[DemoCountry.enum.co].destination,
    items: [
      tripItem(0, F.primaryCard, C['cat-travel'], 'Vuelo Avianca a Cartagena', 620000),
      tripItem(0, F.primaryCard, C['cat-travel'], 'Hotel Casa San Agustín Cartagena', 1850000),
      tripItem(0, F.checking, C['cat-transport'], 'Taxi del aeropuerto de Cartagena', 18000),
      tripItem(1, F.secondaryCard, C['cat-food'], 'Cena en La Cevichería Cartagena', 310000),
      tripItem(1, F.secondaryCard, C['cat-transport'], 'Alquiler de carro Cartagena', 480000),
      tripItem(2, F.secondaryCard, C['cat-leisure'], 'Tour a las Islas del Rosario Cartagena', 280000),
      tripItem(3, F.wallet, C['cat-food'], 'Almuerzo en Getsemaní Cartagena', 95000),
      tripItem(4, F.secondaryCard, C['cat-shopping'], 'Artesanías en el Centro Histórico Cartagena', 240000),
      tripItem(4, F.primaryCard, C['cat-food'], 'Cena en Café del Mar Cartagena', 260000),
      tripItem(5, F.checking, C['cat-transport'], 'Taxi al aeropuerto de Cartagena', 20000),
    ],
  },
};
