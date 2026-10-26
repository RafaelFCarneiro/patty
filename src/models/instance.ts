import { z } from 'zod';

/** What the database says it is. Only the demo seeder writes `demo`; every other database is `standard`. */
export const InstanceKind = z.enum(['standard', 'demo']);
export type InstanceKind = z.infer<typeof InstanceKind>;
export const DEFAULT_INSTANCE_KIND = InstanceKind.enum.standard;

export const isDemoInstance = (kind: InstanceKind): boolean => kind === InstanceKind.enum.demo;
