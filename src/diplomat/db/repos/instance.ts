import { eq } from 'drizzle-orm';
import { INSTANCE_SETTINGS_ID } from '../../../models/auth/users.js';
import { OWNER_USER_ID } from '../../../models/auth/owner.js';
import { InstanceKind } from '../../../models/instance.js';
import { Locale } from '../../../models/locale.js';
import type { Db } from '../driver.js';
import {
  accounts,
  bills,
  budgets,
  creditCards,
  recurringRules,
  settings,
  tags,
  transactions,
  userSettings,
} from '../schema.js';

export type InstanceRepo = {
  /** What this database says it is, read from the singleton row (not from a path or an env var). */
  kind: () => Promise<InstanceKind>;
  /** The language a demo speaks: the owner's `user_settings.locale`, which the demo seeder sets. */
  locale: () => Promise<Locale>;
  /** Whether any user has any finances here, instance-wide (reference rows — categories, currencies — don't count). */
  hasUserData: () => Promise<boolean>;
};

const USER_DATA_TABLES = [accounts, creditCards, bills, transactions, tags, budgets, recurringRules] as const;

export const instanceRepo = (db: Db): InstanceRepo => ({
  kind: async () => {
    const [row] = await db
      .select({ kind: settings.instanceKind })
      .from(settings)
      .where(eq(settings.id, INSTANCE_SETTINGS_ID))
      .limit(1);
    return InstanceKind.parse(row?.kind);
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
    const found = await Promise.all(USER_DATA_TABLES.map((table) => db.select({ id: table.id }).from(table).limit(1)));
    return found.some((rows) => rows.length > 0);
  },
});
