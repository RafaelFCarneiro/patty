import * as R from 'remeda';
import {
  checkVersion,
  INITIAL_VERSION,
  PersistOp,
  type FlowOutcome,
  type Persistable,
  type PersistOutcome,
} from '@rfc0/effect-runner';
import { type EntityDbAdapter } from '../models/persistence.js';

export const insert = <Tag extends string, Model>(fields: {
  entity: Tag;
  model: Model;
  idempotencyKey?: string;
}): Persistable<Tag, Model> => ({
  op: PersistOp.enum.insert,
  ...fields,
});

export const update = <Tag extends string, Model extends { version: number }>(fields: {
  entity: Tag;
  model: Model;
}): Persistable<Tag, Model> => ({
  op: PersistOp.enum.update,
  ...fields,
});

export const remove = <Tag extends string>(fields: { entity: Tag; id: string; version: number }): Persistable<Tag> => ({
  op: PersistOp.enum.delete,
  ...fields,
});

export const check = <Tag extends string>(fields: { entity: Tag; id: string; version: number }): Persistable<Tag> =>
  checkVersion(fields.entity, fields.id, fields.version);

export const outcomeFor = (tag: string, outcomes: PersistOutcome[]): PersistOutcome => {
  const matches = R.filter(outcomes, (o) => o.entity === tag);
  const [outcome] = matches;
  if (!outcome) throw new Error(`outcomeFor: no persist outcome found for entity "${tag}"`);
  if (matches.length > 1) throw new Error(`outcomeFor: multiple persist outcomes found for entity "${tag}"`);
  return outcome;
};

export const entityDbAdapter = <Tag extends string, Model, Row extends { version: number }>(
  entity: Tag,
  modelToDb: (model: Model & { version: number }) => Row,
): EntityDbAdapter => {
  const persistableToDb = (p: Persistable): Persistable => {
    if (p.entity !== entity) return p;
    switch (p.op) {
      case PersistOp.enum.insert:
        return { ...p, model: modelToDb({ ...(p.model as Model), version: INITIAL_VERSION }) };
      case PersistOp.enum.update:
        return { ...p, model: modelToDb(p.model as Model & { version: number }) };
      case PersistOp.enum.delete:
      case PersistOp.enum.check:
        return p;
      default: {
        const _exhaustive: never = p;
        throw new Error(`entityDbAdapter(${entity}): unhandled persistable op ${JSON.stringify(_exhaustive)}`);
      }
    }
  };

  const outcomeToDb = <T>(outcome: FlowOutcome<T>): FlowOutcome<T> => ({
    ...outcome,
    persist: outcome.persist.map(persistableToDb),
  });

  return { persistableToDb, outcomeToDb };
};
