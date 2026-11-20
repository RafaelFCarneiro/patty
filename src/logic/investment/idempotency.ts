import { createHash } from 'node:crypto';
import type { InvestmentEventIdentity } from '../../models/investment/core.js';
import { joinUnambiguously } from '../idempotency.js';
import { roundToDecimals } from '../money.js';

export const deriveKey = (identity: InvestmentEventIdentity, decimals: number, discriminator?: string): string =>
  createHash('sha256')
    .update(
      joinUnambiguously([
        identity.accountId,
        identity.assetId,
        identity.type,
        identity.date,
        identity.quantity,
        roundToDecimals(identity.unitCost, decimals),
        discriminator ?? null,
      ]),
    )
    .digest('hex');
