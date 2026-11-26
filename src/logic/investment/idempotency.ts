import type { InvestmentEventIdentity } from '../../models/investment/core.js';
import { keyOf } from '../idempotency.js';
import { roundToDecimals } from '../money.js';

export const deriveKey = (identity: InvestmentEventIdentity, decimals: number, discriminator?: string): string =>
  keyOf([
    identity.accountId,
    identity.assetId,
    identity.type,
    identity.date,
    identity.quantity,
    roundToDecimals(identity.unitCost, decimals),
    discriminator ?? null,
  ]);
