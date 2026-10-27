import { DemoCountry, DemoFunding, type DemoPack } from '../../../../models/demo.js';
import { TOUR_FACTS } from '../../../../models/tour.js';
import { Locale } from '../../../../models/locale.js';
import { CurrencyCode } from '../../../../models/money.js';
import { DefaultCategoryId } from '../categories.js';
import { BUDGET_SHAPES, fixedLine, pendingLine, spendLine, tripItem } from './shared.js';

const C = DefaultCategoryId.enum;
const F = DemoFunding.enum;
const WORK = 'work';
const FAMILY = 'family';

/** United States: en, USD — Chase, Amex and Nubank, a trip to Denver. */
export const US_PACK: DemoPack = {
  country: DemoCountry.enum.us,
  locale: Locale.enum.en,
  currency: CurrencyCode.enum.USD,
  amountStep: 0.01,
  usdRate: 1,
  accounts: {
    checking: { name: 'Chase Checking', initialBalance: 4200 },
    savings: { name: 'Nubank Savings', initialBalance: 9500 },
    investment: { name: 'Fidelity Brokerage', initialBalance: 28000 },
    wallet: { name: 'Cash Wallet', initialBalance: 150 },
    usdc: { name: 'USDC Wallet', initialBalance: 600 },
    btc: { name: 'BTC Wallet', initialBalance: 0.0185 },
  },
  cards: {
    primary: { name: 'Chase Sapphire', closingDay: 5, dueDay: 28, limit: 9000 },
    secondary: { name: 'Amex Gold', closingDay: 18, dueDay: 12, limit: 12000 },
  },
  tags: [WORK, FAMILY],
  salary: fixedLine(C['cat-salary'], 'Paycheck Acme Corp', 5400, 1),
  rent: fixedLine(C['cat-housing'], 'Rent Maple Apartments', 1850, 3),
  subscriptions: [
    fixedLine(C['cat-subscriptions'], 'Netflix', 15.49, 12),
    fixedLine(C['cat-subscriptions'], 'Spotify', 11.99, 15),
    fixedLine(C['cat-health'], 'Planet Fitness membership', 24.99, 8),
    fixedLine(C['cat-utilities'], 'Xfinity internet', 69.99, 20),
  ],
  freelance: fixedLine(C['cat-extra-income'], 'Freelance design project', 1400, 18),
  spending: [
    spendLine(F.primaryCard, C['cat-food'], 'Whole Foods', [70, 190], 2),
    spendLine(F.checking, C['cat-food'], "Trader Joe's", [45, 120], 2),
    spendLine(F.wallet, C['cat-food'], 'Farmers market', [20, 45], 2),
    spendLine(F.primaryCard, C['cat-food'], 'DoorDash', [22, 55], 4),
    spendLine(F.secondaryCard, C['cat-food'], 'Chipotle', [12, 19], 3),
    spendLine(F.wallet, C['cat-food'], 'Blue Bottle Coffee', [5, 11], 4),
    spendLine(F.primaryCard, C['cat-food'], 'Client lunch', [40, 90], 1, WORK),
    spendLine(F.primaryCard, C['cat-transport'], 'Lyft', [11, 38], 5),
    spendLine(F.checking, C['cat-transport'], 'Uber', [12, 34], 2),
    spendLine(F.secondaryCard, C['cat-transport'], 'Shell gas station', [38, 65], 2),
    spendLine(F.wallet, C['cat-transport'], 'Parking Impark', [8, 22], 1),
    spendLine(F.checking, C['cat-health'], 'CVS Pharmacy', [12, 60], 2),
    spendLine(F.checking, C['cat-health'], 'Dr. Patel copay', [35, 35], 1),
    spendLine(F.primaryCard, C['cat-leisure'], 'AMC Theatres', [14, 32], 1),
    spendLine(F.secondaryCard, C['cat-leisure'], 'The Tipsy Crow', [40, 110], 2),
    spendLine(F.secondaryCard, C['cat-shopping'], 'Amazon', [22, 180], 2),
    spendLine(F.primaryCard, C['cat-shopping'], 'Target', [30, 140], 1),
    spendLine(F.secondaryCard, C['cat-shopping'], 'Nike Store', [60, 140], 1),
    spendLine(F.secondaryCard, C['cat-shopping'], 'Gift for the family', [40, 120], 1, FAMILY),
    spendLine(F.checking, C['cat-utilities'], 'PG&E electric bill', [70, 130], 1),
    spendLine(F.checking, C['cat-utilities'], 'City water bill', [35, 60], 1),
    spendLine(F.secondaryCard, C['cat-education'], 'Coursera', [49, 49], 1),
  ],
  transfers: {
    savings: { description: 'Monthly savings', amount: 800 },
    investment: { description: 'Brokerage contribution', amount: 500 },
    wallet: { description: 'ATM cash withdrawal', amount: 120 },
  },
  pending: [
    pendingLine(C['cat-housing'], 'HOA fee', 220, 5),
    pendingLine(C['cat-transport'], 'Car insurance', 140, 8),
    pendingLine(C['cat-extra-income'], 'Expense reimbursement', 320, 3, true),
  ],
  budgets: BUDGET_SHAPES,
  trip: {
    destination: TOUR_FACTS[DemoCountry.enum.us].destination,
    items: [
      tripItem(0, F.primaryCard, C['cat-travel'], 'United Airlines flight to Denver', 412),
      tripItem(0, F.primaryCard, C['cat-travel'], 'Hotel Monaco Denver', 890),
      tripItem(0, F.checking, C['cat-transport'], 'Lyft from Denver airport', 48),
      tripItem(1, F.secondaryCard, C['cat-food'], 'Dinner at Tavernetta Denver', 168),
      tripItem(1, F.secondaryCard, C['cat-transport'], 'Rental car Hertz Denver', 245),
      tripItem(2, F.secondaryCard, C['cat-leisure'], 'Red Rocks Amphitheatre tickets Denver', 120),
      tripItem(3, F.wallet, C['cat-food'], 'Lunch at Union Station Denver', 38),
      tripItem(4, F.secondaryCard, C['cat-shopping'], 'Gifts at Larimer Square Denver', 96),
      tripItem(4, F.primaryCard, C['cat-food'], 'Dinner at Rioja Denver', 142),
      tripItem(5, F.checking, C['cat-transport'], 'Lyft to Denver airport', 52),
    ],
  },
};
