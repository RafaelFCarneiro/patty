import { eq, isNotNull } from 'drizzle-orm';
import { INSTANCE_SETTINGS_ID } from '../../../models/auth/users.js';
import { OWNER_USER_ID } from '../../../models/auth/owner.js';
import { DemoCountry } from '../../../models/demo.js';
import { InstanceKind } from '../../../models/instance.js';
import { Locale } from '../../../models/locale.js';
import type { Db } from '../driver.js';
import {
  accounts,
  bills,
  budgets,
  categories,
  creditCards,
  currencyRates,
  dashboards,
  merchantCategory,
  recurringRules,
  settings,
  tags,
  transactions,
  userSettings,
} from '../schema.js';

export type InstanceRepo = {
  /** What this database says it is, read from the singleton row (not from a path or an env var). */
  kind: () => Promise<InstanceKind>;
  /** The data set a demo was seeded with; null when none was recorded (a demo seeded before it was). */
  country: () => Promise<DemoCountry | null>;
  /** The language a demo speaks: the owner's `user_settings.locale`, which the demo seeder sets. */
  locale: () => Promise<Locale>;
  /** Whether any user has any finances here, instance-wide (reference rows — categories, currencies — don't count). */
  hasUserData: () => Promise<boolean>;
};

const USER_DATA_TABLES = [
  accounts,
  creditCards,
  bills,
  transactions,
  tags,
  budgets,
  recurringRules,
  currencyRates,
] as const;
/** Tables whose rows are shared defaults (no owner) or a user's own: only the owned ones are user data. */
const SHARED_OR_OWNED_TABLES = [categories, dashboards] as const;

export const instanceRepo = (db: Db): InstanceRepo => ({
  kind: async () => {
    const [row] = await db
      .select({ kind: settings.instanceKind })
      .from(settings)
      .where(eq(settings.id, INSTANCE_SETTINGS_ID))
      .limit(1);
    return InstanceKind.parse(row?.kind);
  },
  country: async () => {
    const [row] = await db
      .select({ country: settings.demoCountry })
      .from(settings)
      .where(eq(settings.id, INSTANCE_SETTINGS_ID))
      .limit(1);
    return DemoCountry.nullable().parse(row?.country ?? null);
  },
  locale: async () => {
    const [row] = await db
      .select({ locale: userSettings.locale })
      .from(userSettings)
      .where(eq(userSettings.userId, OWNER_USER_ID))
      .limit(1);
    return Locale.catch(Locale.enum.en).parse(row?.locale);
  },
  hasUserData: async () => {
    const found = await Promise.all([
      ...USER_DATA_TABLES.map((table) => db.select({ id: table.id }).from(table).limit(1)),
      ...SHARED_OR_OWNED_TABLES.map((table) =>
        db.select({ id: table.id }).from(table).where(isNotNull(table.userId)).limit(1),
      ),
      // Merchant history has no `id`: its own projection; shared rules (no owner) are not user data.
      db
        .select({ key: merchantCategory.merchantKey })
        .from(merchantCategory)
        .where(isNotNull(merchantCategory.userId))
        .limit(1),
    ]);
    return found.some((rows) => rows.length > 0);
  },
});
