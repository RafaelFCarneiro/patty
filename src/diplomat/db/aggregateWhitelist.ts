import { sql } from 'drizzle-orm';
import { AggregateGroupBy, AggregateMetric } from '../../models/aggregate.js';

type SqlFragment = ReturnType<typeof sql>;

export type GroupByFragment = {
  expr: SqlFragment;
  join: SqlFragment;
  label: SqlFragment;
  labelNames?: SqlFragment;
};

export const GROUP_BY_MAP: Record<AggregateGroupBy, GroupByFragment> = {
  [AggregateGroupBy.enum.category]: {
    expr: sql`t.category_id`,
    join: sql`LEFT JOIN categories c ON c.id = t.category_id`,
    label: sql`c.name`,
    labelNames: sql`c.names`,
  },
  [AggregateGroupBy.enum.account]: {
    expr: sql`t.from_account_id`,
    join: sql`LEFT JOIN accounts a ON a.id = t.from_account_id`,
    label: sql`a.name`,
  },
  [AggregateGroupBy.enum.tag]: {
    expr: sql`tg.name`,
    join: sql`JOIN transaction_tags tt ON tt.transaction_id = t.id JOIN tags tg ON tg.id = tt.tag_id`,
    label: sql`tg.name`,
  },
  [AggregateGroupBy.enum.month]: {
    expr: sql`substr(t.date, 1, 7)`,
    join: sql``,
    label: sql`substr(t.date, 1, 7)`,
  },
  [AggregateGroupBy.enum.merchant]: {
    expr: sql`t.merchant_key`,
    join: sql``,
    label: sql`t.merchant_key`,
  },
};

export const METRIC_MAP: Record<AggregateMetric, SqlFragment> = {
  [AggregateMetric.enum.sum]: sql`SUM(t.amount)`,
  [AggregateMetric.enum.count]: sql`COUNT(*)`,
  [AggregateMetric.enum.avg]: sql`AVG(t.amount)`,
};
