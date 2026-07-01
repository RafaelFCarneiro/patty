import { z } from 'zod';
import { DefaultCategoryId } from './categories.js';

const D = DefaultCategoryId.enum;

/**
 * A seed merchant rule maps a normalized merchant **key** (matched as a substring of the
 * normalized transaction description) to a canonical category **slug**. Identity is the slug —
 * never a localized name — so the rules are language-independent in their target; only the
 * *keys* vary by language.
 *
 * Authoring rules (matching is `description LIKE '%key%'`, ties broken by longer key):
 * - Keys must be normalized: lowercase, accent-free, letters + single spaces only (mirror
 *   `logic/merchant.ts#normalizeMerchant`). They are re-normalized at seed time, so authoring
 *   them already-normalized is belt-and-suspenders, not required.
 * - Prefer distinctive keys of 4+ characters. Avoid short tokens that embed in unrelated words
 *   (`gas` ⊂ `gasolina`, `tax` ⊂ `taxi`, `bar` ⊂ `embarque`) — they misfire.
 * - When a longer, more specific key should win over a generic one (e.g. `uber eats`→food over
 *   `uber`→transport), add both: the length tiebreak resolves it.
 */
export const MerchantRule = z.object({
  key: z.string().min(1),
  category: DefaultCategoryId,
});
export type MerchantRule = z.infer<typeof MerchantRule>;

// ─── Language-agnostic brands ──────────────────────────────────────────────────
// Recognised regardless of locale, so a mixed statement (a Brazilian with Uber, Netflix
// and iFood) classifies out of the box. Longer-first where a brand must beat a generic key.
const brandRules: MerchantRule[] = [
  // Ride-hailing & mobility
  { key: 'uber eats', category: D['cat-food'] }, // longer than 'uber' → wins the tiebreak
  { key: 'uber', category: D['cat-transport'] },
  { key: 'lyft', category: D['cat-transport'] },
  { key: 'cabify', category: D['cat-transport'] },
  { key: 'didi', category: D['cat-transport'] },

  // Food delivery
  { key: 'ifood', category: D['cat-food'] },
  { key: 'rappi', category: D['cat-food'] },
  { key: 'doordash', category: D['cat-food'] },
  { key: 'deliveroo', category: D['cat-food'] },
  { key: 'glovo', category: D['cat-food'] },

  // Streaming & subscriptions
  { key: 'netflix', category: D['cat-subscriptions'] },
  { key: 'spotify', category: D['cat-subscriptions'] },
  { key: 'disney', category: D['cat-subscriptions'] },
  { key: 'youtube premium', category: D['cat-subscriptions'] },
  { key: 'hbo', category: D['cat-subscriptions'] },
  { key: 'paramount', category: D['cat-subscriptions'] },

  // Marketplaces & retail
  { key: 'amazon prime', category: D['cat-subscriptions'] }, // longer than 'amazon' → wins
  { key: 'amazon', category: D['cat-shopping'] },
  { key: 'mercado livre', category: D['cat-shopping'] }, // longer than 'mercado' (food) → wins
  { key: 'mercado libre', category: D['cat-shopping'] },
  { key: 'aliexpress', category: D['cat-shopping'] },
  { key: 'shopee', category: D['cat-shopping'] },
  { key: 'walmart', category: D['cat-shopping'] },

  // Travel
  { key: 'airbnb', category: D['cat-travel'] },
  { key: 'booking com', category: D['cat-travel'] },
  { key: 'latam', category: D['cat-travel'] },
];

// ─── English keyword pack ───────────────────────────────────────────────────────
const enRules: MerchantRule[] = [
  { key: 'restaurant', category: D['cat-food'] },
  { key: 'grocery', category: D['cat-food'] },
  { key: 'supermarket', category: D['cat-food'] },
  { key: 'bakery', category: D['cat-food'] },
  { key: 'coffee', category: D['cat-food'] },

  // Transport (avoid bare 'gas' — it embeds in 'gasoline'; use specific keys)
  { key: 'gas station', category: D['cat-transport'] },
  { key: 'gasoline', category: D['cat-transport'] },
  { key: 'fuel', category: D['cat-transport'] },
  { key: 'parking', category: D['cat-transport'] },
  { key: 'taxi', category: D['cat-transport'] },

  { key: 'rent', category: D['cat-housing'] },
  { key: 'mortgage', category: D['cat-housing'] },

  { key: 'electric', category: D['cat-utilities'] },
  { key: 'water bill', category: D['cat-utilities'] },
  { key: 'internet', category: D['cat-utilities'] },
  { key: 'mobile', category: D['cat-utilities'] },

  { key: 'pharmacy', category: D['cat-health'] },
  { key: 'doctor', category: D['cat-health'] },
  { key: 'dentist', category: D['cat-health'] },
  { key: 'hospital', category: D['cat-health'] },

  { key: 'school', category: D['cat-education'] },
  { key: 'university', category: D['cat-education'] },
  { key: 'tuition', category: D['cat-education'] },

  { key: 'cinema', category: D['cat-leisure'] },
  { key: 'theater', category: D['cat-leisure'] },

  { key: 'hotel', category: D['cat-travel'] },
  { key: 'airline', category: D['cat-travel'] },
  { key: 'flight', category: D['cat-travel'] },

  { key: 'salary', category: D['cat-salary'] },
  { key: 'payroll', category: D['cat-salary'] },

  // Taxes (avoid bare 'tax' — it embeds in 'taxi')
  { key: 'income tax', category: D['cat-taxes'] },
];

// ─── Portuguese (BR/PT) keyword pack ────────────────────────────────────────────
const ptRules: MerchantRule[] = [
  { key: 'restaurante', category: D['cat-food'] },
  { key: 'lanchonete', category: D['cat-food'] },
  { key: 'padaria', category: D['cat-food'] },
  { key: 'mercado', category: D['cat-food'] },
  { key: 'supermercado', category: D['cat-food'] },
  { key: 'acougue', category: D['cat-food'] },
  { key: 'hortifruti', category: D['cat-food'] },

  // Transporte (sem 'gas' isolado — colide com 'gasolina')
  { key: 'posto', category: D['cat-transport'] },
  { key: 'gasolina', category: D['cat-transport'] },
  { key: 'combustivel', category: D['cat-transport'] },
  { key: 'estacionamento', category: D['cat-transport'] },
  { key: 'pedagio', category: D['cat-transport'] },
  { key: 'metro', category: D['cat-transport'] },

  { key: 'aluguel', category: D['cat-housing'] },
  { key: 'condominio', category: D['cat-housing'] },

  { key: 'conta de luz', category: D['cat-utilities'] },
  { key: 'energia', category: D['cat-utilities'] },
  { key: 'conta de agua', category: D['cat-utilities'] },
  { key: 'internet', category: D['cat-utilities'] },
  { key: 'telefone', category: D['cat-utilities'] },

  { key: 'farmacia', category: D['cat-health'] },
  { key: 'drogaria', category: D['cat-health'] },
  { key: 'medico', category: D['cat-health'] },
  { key: 'dentista', category: D['cat-health'] },
  { key: 'hospital', category: D['cat-health'] },
  { key: 'academia', category: D['cat-health'] },

  { key: 'escola', category: D['cat-education'] },
  { key: 'faculdade', category: D['cat-education'] },
  { key: 'mensalidade', category: D['cat-education'] },
  { key: 'curso', category: D['cat-education'] },

  { key: 'cinema', category: D['cat-leisure'] },
  { key: 'teatro', category: D['cat-leisure'] },

  { key: 'hotel', category: D['cat-travel'] },
  { key: 'pousada', category: D['cat-travel'] },
  { key: 'passagem', category: D['cat-travel'] },

  { key: 'salario', category: D['cat-salary'] },

  { key: 'imposto', category: D['cat-taxes'] },
  { key: 'iptu', category: D['cat-taxes'] },
  { key: 'ipva', category: D['cat-taxes'] },
  { key: 'darf', category: D['cat-taxes'] },
];

// ─── Spanish keyword pack ───────────────────────────────────────────────────────
const esRules: MerchantRule[] = [
  { key: 'restaurante', category: D['cat-food'] },
  { key: 'cafeteria', category: D['cat-food'] },
  { key: 'panaderia', category: D['cat-food'] },
  { key: 'supermercado', category: D['cat-food'] },
  { key: 'mercado', category: D['cat-food'] },
  { key: 'carniceria', category: D['cat-food'] },

  // Transporte (sin 'gas' suelto — colisiona con 'gasolina')
  { key: 'gasolinera', category: D['cat-transport'] },
  { key: 'gasolina', category: D['cat-transport'] },
  { key: 'combustible', category: D['cat-transport'] },
  { key: 'estacionamiento', category: D['cat-transport'] },
  { key: 'peaje', category: D['cat-transport'] },
  { key: 'metro', category: D['cat-transport'] },

  { key: 'alquiler', category: D['cat-housing'] },
  { key: 'hipoteca', category: D['cat-housing'] },
  { key: 'comunidad', category: D['cat-housing'] },

  { key: 'electricidad', category: D['cat-utilities'] },
  { key: 'recibo de luz', category: D['cat-utilities'] },
  { key: 'agua', category: D['cat-utilities'] },
  { key: 'internet', category: D['cat-utilities'] },
  { key: 'telefono', category: D['cat-utilities'] },

  { key: 'farmacia', category: D['cat-health'] },
  { key: 'medico', category: D['cat-health'] },
  { key: 'dentista', category: D['cat-health'] },
  { key: 'hospital', category: D['cat-health'] },
  { key: 'gimnasio', category: D['cat-health'] },

  { key: 'colegio', category: D['cat-education'] },
  { key: 'universidad', category: D['cat-education'] },
  { key: 'matricula', category: D['cat-education'] },
  { key: 'curso', category: D['cat-education'] },

  { key: 'cine', category: D['cat-leisure'] },
  { key: 'teatro', category: D['cat-leisure'] },

  { key: 'hotel', category: D['cat-travel'] },
  { key: 'vuelo', category: D['cat-travel'] },
  { key: 'pasaje', category: D['cat-travel'] },

  { key: 'nomina', category: D['cat-salary'] },
  { key: 'salario', category: D['cat-salary'] },
  { key: 'sueldo', category: D['cat-salary'] },

  { key: 'impuesto', category: D['cat-taxes'] },
  { key: 'hacienda', category: D['cat-taxes'] },
];

/**
 * Canonical default merchant rules, additive across languages: brands + en/pt/es unioned and
 * loaded for every user (locale drives display names, never which rules apply). Keys are
 * re-normalized and deduped by (key, category) at seed time (`bootstrap.ts`). Add a locale by
 * appending a new pack here.
 */
export const DEFAULT_MERCHANT_RULES: MerchantRule[] = [...brandRules, ...enRules, ...ptRules, ...esRules];
