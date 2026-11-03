import { DemoCountry, DemoFunding, type DemoPack } from '../../../../models/demo.js';
import { TOUR_FACTS } from '../../../../models/tour.js';
import { Locale } from '../../../../models/locale.js';
import { CurrencyCode } from '../../../../models/money.js';
import { DefaultCategoryId } from '../categories.js';
import { BUDGET_SHAPES, fixedLine, pendingLine, spendLine, tripItem } from './shared.js';

const C = DefaultCategoryId.enum;
const F = DemoFunding.enum;
const WORK = 'trabalho';
const FAMILY = 'família';

/** Brazil: pt, BRL — Nubank and Itaú, a dollar Conta Global, a trip to Florianópolis. */
export const BR_PACK: DemoPack = {
  country: DemoCountry.enum.br,
  locale: Locale.enum.pt,
  currency: CurrencyCode.enum.BRL,
  amountStep: 0.01,
  usdRate: 5.4,
  accounts: {
    checking: { name: 'Nubank', initialBalance: 6500 },
    savings: { name: 'Caixinha Nubank', initialBalance: 18000 },
    investment: { name: 'Itaú Investimentos', initialBalance: 42000 },
    wallet: { name: 'Carteira', initialBalance: 300 },
    usdc: { name: 'Cripto USDC', initialBalance: 420 },
    btc: { name: 'Cripto BTC', initialBalance: 0.0185 },
  },
  global: {
    name: 'Nubank Conta Global',
    initialBalance: 600,
    spending: [
      spendLine(F.global, C['cat-shopping'], 'Amazon.com', [18, 75], 1),
      spendLine(F.global, C['cat-education'], 'Udemy', [12, 30], 1),
    ],
  },
  cards: {
    primary: { name: 'Nubank Roxinho', closingDay: 3, dueDay: 10, limit: 12000 },
    secondary: { name: 'Itaú Platinum', closingDay: 20, dueDay: 27, limit: 18000 },
  },
  tags: [WORK, FAMILY],
  salary: fixedLine(C['cat-salary'], 'Salário Empresa XYZ', 8500, 5),
  rent: fixedLine(C['cat-housing'], 'Aluguel', 2200, 8),
  subscriptions: [
    fixedLine(C['cat-subscriptions'], 'Netflix', 55.9, 12),
    fixedLine(C['cat-subscriptions'], 'Spotify', 21.9, 15),
    fixedLine(C['cat-health'], 'Academia SmartFit', 119.9, 10),
    fixedLine(C['cat-utilities'], 'Internet Vivo Fibra', 129.9, 20),
  ],
  freelance: fixedLine(C['cat-extra-income'], 'Freelance site institucional', 1800, 18),
  spending: [
    spendLine(F.primaryCard, C['cat-food'], 'Pão de Açúcar', [180, 420], 2),
    spendLine(F.checking, C['cat-food'], 'Mercado Assaí', [120, 300], 1),
    spendLine(F.wallet, C['cat-food'], 'Hortifruti Natural', [40, 90], 2),
    spendLine(F.primaryCard, C['cat-food'], 'iFood', [38, 95], 4),
    spendLine(F.secondaryCard, C['cat-food'], 'Restaurante Madero', [90, 220], 2),
    spendLine(F.wallet, C['cat-food'], 'Padaria Pão Quente', [12, 35], 3),
    spendLine(F.primaryCard, C['cat-food'], 'Almoço com cliente', [70, 150], 1, WORK),
    spendLine(F.primaryCard, C['cat-transport'], 'Uber', [14, 48], 5),
    spendLine(F.checking, C['cat-transport'], '99 Táxi', [12, 35], 2),
    spendLine(F.secondaryCard, C['cat-transport'], 'Posto Shell', [180, 260], 1),
    spendLine(F.wallet, C['cat-transport'], 'Estacionamento Shopping', [15, 40], 1),
    spendLine(F.checking, C['cat-health'], 'Farmácia Drogasil', [35, 160], 2),
    spendLine(F.checking, C['cat-health'], 'Consulta Dr. Silva', [280, 320], 1),
    spendLine(F.primaryCard, C['cat-leisure'], 'Cinema Cinemark', [45, 90], 1),
    spendLine(F.secondaryCard, C['cat-leisure'], 'Bar do Zé', [80, 200], 2),
    spendLine(F.secondaryCard, C['cat-shopping'], 'Amazon', [70, 350], 1),
    spendLine(F.primaryCard, C['cat-shopping'], 'Mercado Livre', [60, 280], 1),
    spendLine(F.secondaryCard, C['cat-shopping'], 'Renner', [120, 380], 1),
    spendLine(F.secondaryCard, C['cat-shopping'], 'Presente para a família', [80, 200], 1, FAMILY),
    spendLine(F.checking, C['cat-utilities'], 'Conta de luz Enel', [140, 230], 1),
    spendLine(F.checking, C['cat-utilities'], 'Conta de água Sabesp', [70, 120], 1),
    spendLine(F.checking, C['cat-education'], 'Escola de inglês', [390, 390], 1),
  ],
  transfers: {
    savings: { description: 'Aporte mensal', amount: 1500 },
    investment: { description: 'Aporte Tesouro Selic', amount: 1000 },
    wallet: { description: 'Saque para a carteira', amount: 400 },
  },
  pending: [
    pendingLine(C['cat-housing'], 'Condomínio', 780, 5),
    pendingLine(C['cat-transport'], 'Seguro do carro', 350, 9),
    pendingLine(C['cat-extra-income'], 'Reembolso de despesas', 450, 3, true),
  ],
  budgets: BUDGET_SHAPES,
  trip: {
    destination: TOUR_FACTS[DemoCountry.enum.br].destination,
    items: [
      tripItem(0, F.primaryCard, C['cat-travel'], 'Passagem aérea LATAM para Florianópolis', 1380),
      tripItem(0, F.primaryCard, C['cat-travel'], 'Pousada Ilha Azul Florianópolis', 2150),
      tripItem(0, F.checking, C['cat-transport'], 'Uber do aeroporto de Florianópolis', 62),
      tripItem(1, F.secondaryCard, C['cat-food'], 'Restaurante Ostradamus Florianópolis', 380),
      tripItem(1, F.secondaryCard, C['cat-transport'], 'Aluguel de carro Localiza Florianópolis', 640),
      tripItem(2, F.secondaryCard, C['cat-leisure'], 'Passeio de barco Ilha do Campeche Florianópolis', 260),
      tripItem(3, F.wallet, C['cat-food'], 'Almoço Lagoa da Conceição Florianópolis', 145),
      tripItem(4, F.secondaryCard, C['cat-shopping'], 'Lembranças Mercado Público Florianópolis', 320),
      tripItem(4, F.primaryCard, C['cat-food'], 'Jantar Santo Antônio de Lisboa Florianópolis', 290),
      tripItem(5, F.checking, C['cat-transport'], 'Táxi para o aeroporto de Florianópolis', 85),
    ],
  },
};
