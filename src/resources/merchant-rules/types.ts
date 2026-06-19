/**
 * Seed merchant-rule contract.
 *
 * A rule maps a normalized merchant **key** (a substring of the normalized transaction
 * description) to a canonical category **slug**. Identity is the slug — never a localized
 * name — so these packs are language-independent in their target and only the *keys* vary
 * by language.
 *
 * Authoring rules (matching is `description LIKE '%key%'`, ties broken by longer key):
 * - Keys must be normalized: lowercase, accent-free, letters + single spaces only
 *   (mirror `logic/merchant.ts#normalizeMerchant`). They are re-normalized at seed time,
 *   so authoring them already-normalized is belt-and-suspenders, not required.
 * - Prefer distinctive keys of 4+ characters. Avoid short tokens that embed in unrelated
 *   words (e.g. `gas` lives inside `gasolina`; `bar` inside `embarque`) — they misfire.
 * - When a longer, more specific key should win over a generic one (e.g. `uber eats`→food
 *   over `uber`→transport), just add both: the length tiebreak resolves it.
 */

/** The 15 canonical default-category slugs. Mirrors the seeded categories in `bootstrap.ts`. */
export type CategoryId =
  | 'cat-food'
  | 'cat-transport'
  | 'cat-housing'
  | 'cat-utilities'
  | 'cat-health'
  | 'cat-education'
  | 'cat-leisure'
  | 'cat-shopping'
  | 'cat-subscriptions'
  | 'cat-travel'
  | 'cat-taxes'
  | 'cat-salary'
  | 'cat-extra-income'
  | 'cat-investments'
  | 'cat-other'

export type MerchantRule = { key: string; category: CategoryId }
