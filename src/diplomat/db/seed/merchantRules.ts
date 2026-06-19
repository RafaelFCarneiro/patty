import { z } from 'zod'
import { DefaultCategoryId } from './categories.js'

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
})
export type MerchantRule = z.infer<typeof MerchantRule>

// ─── Language-agnostic brands ──────────────────────────────────────────────────
// Recognised regardless of locale, so a mixed statement (a Brazilian with Uber, Netflix
// and iFood) classifies out of the box. Longer-first where a brand must beat a generic key.
const brandRules: MerchantRule[] = [
  // Ride-hailing & mobility
  { key: 'uber eats', category: 'cat-food' }, // longer than 'uber' → wins the tiebreak
  { key: 'uber', category: 'cat-transport' },
  { key: 'lyft', category: 'cat-transport' },
  { key: 'cabify', category: 'cat-transport' },
  { key: 'didi', category: 'cat-transport' },

  // Food delivery
  { key: 'ifood', category: 'cat-food' },
  { key: 'rappi', category: 'cat-food' },
  { key: 'doordash', category: 'cat-food' },
  { key: 'deliveroo', category: 'cat-food' },
  { key: 'glovo', category: 'cat-food' },

  // Streaming & subscriptions
  { key: 'netflix', category: 'cat-subscriptions' },
  { key: 'spotify', category: 'cat-subscriptions' },
  { key: 'disney', category: 'cat-subscriptions' },
  { key: 'youtube premium', category: 'cat-subscriptions' },
  { key: 'hbo', category: 'cat-subscriptions' },
  { key: 'paramount', category: 'cat-subscriptions' },

  // Marketplaces & retail
  { key: 'amazon prime', category: 'cat-subscriptions' }, // longer than 'amazon' → wins
  { key: 'amazon', category: 'cat-shopping' },
  { key: 'mercado livre', category: 'cat-shopping' }, // longer than 'mercado' (food) → wins
  { key: 'mercado libre', category: 'cat-shopping' },
  { key: 'aliexpress', category: 'cat-shopping' },
  { key: 'shopee', category: 'cat-shopping' },
  { key: 'walmart', category: 'cat-shopping' },

  // Travel
  { key: 'airbnb', category: 'cat-travel' },
  { key: 'booking com', category: 'cat-travel' },
  { key: 'latam', category: 'cat-travel' },
]

// ─── English keyword pack ───────────────────────────────────────────────────────
const enRules: MerchantRule[] = [
  { key: 'restaurant', category: 'cat-food' },
  { key: 'grocery', category: 'cat-food' },
  { key: 'supermarket', category: 'cat-food' },
  { key: 'bakery', category: 'cat-food' },
  { key: 'coffee', category: 'cat-food' },

  // Transport (avoid bare 'gas' — it embeds in 'gasoline'; use specific keys)
  { key: 'gas station', category: 'cat-transport' },
  { key: 'gasoline', category: 'cat-transport' },
  { key: 'fuel', category: 'cat-transport' },
  { key: 'parking', category: 'cat-transport' },
  { key: 'taxi', category: 'cat-transport' },

  { key: 'rent', category: 'cat-housing' },
  { key: 'mortgage', category: 'cat-housing' },

  { key: 'electric', category: 'cat-utilities' },
  { key: 'water bill', category: 'cat-utilities' },
  { key: 'internet', category: 'cat-utilities' },
  { key: 'mobile', category: 'cat-utilities' },

  { key: 'pharmacy', category: 'cat-health' },
  { key: 'doctor', category: 'cat-health' },
  { key: 'dentist', category: 'cat-health' },
  { key: 'hospital', category: 'cat-health' },

  { key: 'school', category: 'cat-education' },
  { key: 'university', category: 'cat-education' },
  { key: 'tuition', category: 'cat-education' },

  { key: 'cinema', category: 'cat-leisure' },
  { key: 'theater', category: 'cat-leisure' },

  { key: 'hotel', category: 'cat-travel' },
  { key: 'airline', category: 'cat-travel' },
  { key: 'flight', category: 'cat-travel' },

  { key: 'salary', category: 'cat-salary' },
  { key: 'payroll', category: 'cat-salary' },

  // Taxes (avoid bare 'tax' — it embeds in 'taxi')
  { key: 'income tax', category: 'cat-taxes' },
]

// ─── Portuguese (BR/PT) keyword pack ────────────────────────────────────────────
const ptRules: MerchantRule[] = [
  { key: 'restaurante', category: 'cat-food' },
  { key: 'lanchonete', category: 'cat-food' },
  { key: 'padaria', category: 'cat-food' },
  { key: 'mercado', category: 'cat-food' },
  { key: 'supermercado', category: 'cat-food' },
  { key: 'acougue', category: 'cat-food' },
  { key: 'hortifruti', category: 'cat-food' },

  // Transporte (sem 'gas' isolado — colide com 'gasolina')
  { key: 'posto', category: 'cat-transport' },
  { key: 'gasolina', category: 'cat-transport' },
  { key: 'combustivel', category: 'cat-transport' },
  { key: 'estacionamento', category: 'cat-transport' },
  { key: 'pedagio', category: 'cat-transport' },
  { key: 'metro', category: 'cat-transport' },

  { key: 'aluguel', category: 'cat-housing' },
  { key: 'condominio', category: 'cat-housing' },

  { key: 'conta de luz', category: 'cat-utilities' },
  { key: 'energia', category: 'cat-utilities' },
  { key: 'conta de agua', category: 'cat-utilities' },
  { key: 'internet', category: 'cat-utilities' },
  { key: 'telefone', category: 'cat-utilities' },

  { key: 'farmacia', category: 'cat-health' },
  { key: 'drogaria', category: 'cat-health' },
  { key: 'medico', category: 'cat-health' },
  { key: 'dentista', category: 'cat-health' },
  { key: 'hospital', category: 'cat-health' },
  { key: 'academia', category: 'cat-health' },

  { key: 'escola', category: 'cat-education' },
  { key: 'faculdade', category: 'cat-education' },
  { key: 'mensalidade', category: 'cat-education' },
  { key: 'curso', category: 'cat-education' },

  { key: 'cinema', category: 'cat-leisure' },
  { key: 'teatro', category: 'cat-leisure' },

  { key: 'hotel', category: 'cat-travel' },
  { key: 'pousada', category: 'cat-travel' },
  { key: 'passagem', category: 'cat-travel' },

  { key: 'salario', category: 'cat-salary' },

  { key: 'imposto', category: 'cat-taxes' },
  { key: 'iptu', category: 'cat-taxes' },
  { key: 'ipva', category: 'cat-taxes' },
  { key: 'darf', category: 'cat-taxes' },
]

// ─── Spanish keyword pack ───────────────────────────────────────────────────────
const esRules: MerchantRule[] = [
  { key: 'restaurante', category: 'cat-food' },
  { key: 'cafeteria', category: 'cat-food' },
  { key: 'panaderia', category: 'cat-food' },
  { key: 'supermercado', category: 'cat-food' },
  { key: 'mercado', category: 'cat-food' },
  { key: 'carniceria', category: 'cat-food' },

  // Transporte (sin 'gas' suelto — colisiona con 'gasolina')
  { key: 'gasolinera', category: 'cat-transport' },
  { key: 'gasolina', category: 'cat-transport' },
  { key: 'combustible', category: 'cat-transport' },
  { key: 'estacionamiento', category: 'cat-transport' },
  { key: 'peaje', category: 'cat-transport' },
  { key: 'metro', category: 'cat-transport' },

  { key: 'alquiler', category: 'cat-housing' },
  { key: 'hipoteca', category: 'cat-housing' },
  { key: 'comunidad', category: 'cat-housing' },

  { key: 'electricidad', category: 'cat-utilities' },
  { key: 'recibo de luz', category: 'cat-utilities' },
  { key: 'agua', category: 'cat-utilities' },
  { key: 'internet', category: 'cat-utilities' },
  { key: 'telefono', category: 'cat-utilities' },

  { key: 'farmacia', category: 'cat-health' },
  { key: 'medico', category: 'cat-health' },
  { key: 'dentista', category: 'cat-health' },
  { key: 'hospital', category: 'cat-health' },
  { key: 'gimnasio', category: 'cat-health' },

  { key: 'colegio', category: 'cat-education' },
  { key: 'universidad', category: 'cat-education' },
  { key: 'matricula', category: 'cat-education' },
  { key: 'curso', category: 'cat-education' },

  { key: 'cine', category: 'cat-leisure' },
  { key: 'teatro', category: 'cat-leisure' },

  { key: 'hotel', category: 'cat-travel' },
  { key: 'vuelo', category: 'cat-travel' },
  { key: 'pasaje', category: 'cat-travel' },

  { key: 'nomina', category: 'cat-salary' },
  { key: 'salario', category: 'cat-salary' },
  { key: 'sueldo', category: 'cat-salary' },

  { key: 'impuesto', category: 'cat-taxes' },
  { key: 'hacienda', category: 'cat-taxes' },
]

/**
 * Canonical default merchant rules, additive across languages: brands + en/pt/es unioned and
 * loaded for every user (locale drives display names, never which rules apply). Keys are
 * re-normalized and deduped by (key, category) at seed time (`bootstrap.ts`). Add a locale by
 * appending a new pack here.
 */
export const DEFAULT_MERCHANT_RULES: MerchantRule[] = [
  ...brandRules,
  ...enRules,
  ...ptRules,
  ...esRules,
]
