import { afterEach, describe, expect, it } from 'vitest';
import { toIsoDate } from '../../../src/logic/period.js';
import { callTool, deleteTransactions, makeClient } from './helpers.js';

describe('MCP integration > recurring', () => {
  let createdTxIds: string[] = [];

  afterEach(async () => {
    await deleteTransactions(createdTxIds);
    createdTxIds = [];
  });

  it('materializes overdue transactions via apply_due_recurring', async () => {
    const stamp = Date.now();
    const accountName = `Recurring Test ${stamp}`;
    const ruleDescription = `Monthly sub ${stamp}`;
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 7);
    const startDate = toIsoDate(pastDate);

    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      await callTool(client, {
        name: 'create_recurring',
        args: {
          description: ruleDescription,
          amount: 29.9,
          type: 'expense',
          period: 'monthly',
          startDate,
          account: accountName,
          category: 'Assinaturas',
        },
      });

      const result = (await callTool(client, {
        name: 'apply_due_recurring',
        args: {},
      })) as { applied?: Array<{ rule?: string; transaction?: { id?: string } }>; count?: number };

      const ours = result.applied?.filter((a) => a.rule === ruleDescription) ?? [];
      for (const a of ours) {
        if (a.transaction?.id) createdTxIds.push(a.transaction.id);
      }

      expect(ours.length).toBeGreaterThan(0);
      expect(result.count).toBeGreaterThan(0);
    } finally {
      await transport.close();
    }
  });

  it('yearly recurring rule round-trips through create → list → apply', async () => {
    const stamp = Date.now();
    const accountName = `Yearly Test ${stamp}`;
    const ruleDescription = `Annual sub ${stamp}`;
    const pastDate = new Date();
    pastDate.setFullYear(pastDate.getFullYear() - 1);
    pastDate.setDate(pastDate.getDate() - 1);
    const startDate = toIsoDate(pastDate);

    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      await callTool(client, {
        name: 'create_recurring',
        args: {
          description: ruleDescription,
          amount: 199.9,
          type: 'expense',
          period: 'yearly',
          startDate,
          account: accountName,
        },
      });

      const listed = (await callTool(client, {
        name: 'list_recurring',
        args: {},
      })) as Array<{ description?: string; period?: string }>;

      const ours = listed.find((r) => r.description === ruleDescription);
      expect(ours).toBeDefined();
      expect(ours!.period).toBe('yearly');

      const result = (await callTool(client, {
        name: 'apply_due_recurring',
        args: {},
      })) as { applied?: Array<{ rule?: string; transaction?: { id?: string } }>; count?: number };

      const applied = result.applied?.filter((a) => a.rule === ruleDescription) ?? [];
      for (const a of applied) {
        if (a.transaction?.id) createdTxIds.push(a.transaction.id);
      }

      expect(applied.length).toBeGreaterThan(0);
    } finally {
      await transport.close();
    }
  });

  it('apply_due_recurring(through) stamps past effective and future pending', async () => {
    const stamp = Date.now();
    const accountName = `Recurring Through ${stamp}`;
    const ruleDescription = `Rent Through ${stamp}`;

    const now = new Date();
    const today = toIsoDate(now);
    const pastStart = toIsoDate(new Date(now.getFullYear(), now.getMonth() - 2, 1));
    const futureThrough = toIsoDate(new Date(now.getFullYear(), now.getMonth() + 3, 1));

    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 5000 },
      });

      await callTool(client, {
        name: 'create_recurring',
        args: {
          description: ruleDescription,
          amount: 1000,
          type: 'expense',
          period: 'monthly',
          startDate: pastStart,
          account: accountName,
        },
      });

      const result = (await callTool(client, {
        name: 'apply_due_recurring',
        args: { through: futureThrough },
      })) as { applied?: Array<{ rule?: string; date?: string; transaction?: { id?: string; status?: string } }> };

      const ours = (result.applied ?? []).filter((a) => a.rule === ruleDescription);
      // Collect ids for cleanup
      for (const a of ours) {
        if (a.transaction?.id) createdTxIds.push(a.transaction.id);
      }

      // Every occurrence before/on today should be effective; after today should be pending
      const pastOccurrences = ours.filter((a) => a.date && a.date <= today);
      const futureOccurrences = ours.filter((a) => a.date && a.date > today);

      expect(pastOccurrences.length).toBeGreaterThan(0);
      expect(futureOccurrences.length).toBeGreaterThan(0);

      for (const o of pastOccurrences) {
        expect(o.transaction?.status).toBe('effective');
      }
      for (const o of futureOccurrences) {
        expect(o.transaction?.status).toBe('pending');
      }

      // Re-running is idempotent — count stays the same
      const rerun = (await callTool(client, {
        name: 'apply_due_recurring',
        args: { through: futureThrough },
      })) as { count?: number };
      expect(rerun.count).toBe(0);
    } finally {
      await transport.close();
    }
  });

  it('threads the merchant from create_recurring onto materialized occurrences', async () => {
    const stamp = Date.now();
    const accountName = `Merchant Recurring ${stamp}`;
    const ruleDescription = `Streaming sub ${stamp}`;
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 5);
    const startDate = toIsoDate(pastDate);

    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      await callTool(client, {
        name: 'create_recurring',
        args: {
          description: ruleDescription,
          amount: 39.9,
          type: 'expense',
          period: 'monthly',
          startDate,
          account: accountName,
          merchant: 'Streamflix',
        },
      });

      const result = (await callTool(client, {
        name: 'apply_due_recurring',
        args: {},
      })) as { applied?: Array<{ rule?: string; transaction?: { id?: string; merchant?: string } }> };

      const ours = result.applied?.filter((a) => a.rule === ruleDescription) ?? [];
      for (const a of ours) {
        if (a.transaction?.id) createdTxIds.push(a.transaction.id);
      }

      expect(ours.length).toBeGreaterThan(0);
      for (const a of ours) {
        expect(a.transaction?.merchant).toBe('streamflix');
      }
    } finally {
      await transport.close();
    }
  });

  it('defaults currency to USD when no account is linked', async () => {
    const stamp = Date.now();
    const ruleDescription = `No-account rule ${stamp}`;
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 3);
    const startDate = toIsoDate(pastDate);

    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_recurring',
        args: {
          description: ruleDescription,
          amount: 50,
          type: 'expense',
          period: 'monthly',
          startDate,
          category: 'Assinaturas',
        },
      });

      const listed = (await callTool(client, {
        name: 'list_recurring',
        args: {},
      })) as Array<{ description?: string; currency?: string }>;

      const ours = listed.find((r) => r.description === ruleDescription);
      expect(ours).toBeDefined();
      expect(ours!.currency).toBe('USD');
    } finally {
      await transport.close();
    }
  });
});
