import { describe, expect, it } from 'vitest';
import { toIsoDate } from '../../../src/logic/period.js';
import { callTool, callToolError, makeClient } from './helpers.js';

describe('MCP integration > credit cards as liability accounts (ADR-010)', () => {
  const now = new Date();
  const stamp = now.getTime();
  const cardName = `Liability Card ${stamp}`;
  const bankName = `Bank ${stamp}`;
  const today = toIsoDate(now);
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  it('card creation auto-creates an internal credit account and purchases post to it', async () => {
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      // Create a bank account for later use
      await callTool(client, {
        name: 'create_account',
        args: { name: bankName, type: 'checking', currency: 'BRL', initialBalance: 5000 },
      });

      // Create card with payment account
      const card = (await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL', paymentAccount: bankName },
      })) as { accountId?: string; paymentAccountId?: string };

      expect(card.accountId).toBeDefined();
      expect(card.paymentAccountId).toBeDefined();

      // The internal credit account should appear in list_accounts
      const accounts = (await callTool(client, {
        name: 'list_accounts',
        args: { type: 'credit' },
      })) as Array<{ name?: string; type?: string }>;
      expect(accounts.some((a) => a.name === `Card: ${cardName}`)).toBe(true);

      // Make a card purchase
      await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Liability test purchase ${stamp}`,
          amount: 250,
          type: 'expense',
          date: today,
          card: cardName,
          idempotencyKey: `liability-purchase-${stamp}`,
        },
      });

      // The card's internal account should show negative balance (debt)
      const balances = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: `Card: ${cardName}` },
      })) as Array<{ balance?: number; expenses?: number }>;
      expect(balances[0]?.balance).toBe(-250);
      expect(balances[0]?.expenses).toBe(250);
    } finally {
      await transport.close();
    }
  });

  it('create_transfer rejects credit accounts on either leg', async () => {
    const localCard = `Transfer Reject Card ${stamp}`;
    const localBank = `Transfer Reject Bank ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: localBank, type: 'checking', currency: 'BRL', initialBalance: 1000 },
      });
      await callTool(client, {
        name: 'create_credit_card',
        args: { name: localCard, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });

      const errFrom = (await callToolError(client, {
        name: 'create_transfer',
        args: {
          from: `Card: ${localCard}`,
          to: localBank,
          amount: 100,
          idempotencyKey: `transfer-from-credit-${stamp}`,
        },
      })) as { error?: { code?: string } };
      expect(errFrom.error?.code).toBe('validation');

      const errTo = (await callToolError(client, {
        name: 'create_transfer',
        args: {
          from: localBank,
          to: `Card: ${localCard}`,
          amount: 100,
          idempotencyKey: `transfer-to-credit-${stamp}`,
        },
      })) as { error?: { code?: string } };
      expect(errTo.error?.code).toBe('validation');
    } finally {
      await transport.close();
    }
  });

  it('create_account rejects type credit', async () => {
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      const err = (await callToolError(client, {
        name: 'create_account',
        args: { name: `Manual credit ${stamp}`, type: 'credit', currency: 'BRL' },
      })) as { error?: { code?: string } };
      expect(err.error?.code).toBe('validation');
    } finally {
      await transport.close();
    }
  });

  it('create_transaction rejects direct posting to a credit account via account param', async () => {
    const localCard = `Direct Post Card ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: localCard, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });

      const err = (await callToolError(client, {
        name: 'create_transaction',
        args: {
          description: `Direct credit post ${stamp}`,
          amount: 50,
          type: 'expense',
          date: today,
          account: `Card: ${localCard}`,
          idempotencyKey: `direct-credit-post-${stamp}`,
        },
      })) as { error?: { code?: string } };
      expect(err.error?.code).toBe('validation');
    } finally {
      await transport.close();
    }
  });

  it('spending summary is unchanged — card purchase counts as expense, no double-count', async () => {
    const localCard = `Summary Card ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: localCard, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });

      await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Summary purchase ${stamp}`,
          amount: 150,
          type: 'expense',
          date: today,
          card: localCard,
          idempotencyKey: `summary-purchase-${stamp}`,
        },
      });

      const summary = (await callTool(client, {
        name: 'get_spending_summary',
        args: { month, year },
      })) as { currencies?: Array<{ currency?: string; expenses?: number }> };

      const brl = summary.currencies?.find((s) => s.currency === 'BRL');
      expect(brl?.expenses).toBeGreaterThanOrEqual(150);
    } finally {
      await transport.close();
    }
  });
});
