import { z } from 'zod';
import { Locale } from './locale.js';

/** What the database says it is. Only the demo seeder writes `demo`; every other database is `standard`. */
export const InstanceKind = z.enum(['standard', 'demo']);
export type InstanceKind = z.infer<typeof InstanceKind>;
export const DEFAULT_INSTANCE_KIND = InstanceKind.enum.standard;

export const isDemoInstance = (kind: InstanceKind): boolean => kind === InstanceKind.enum.demo;

/** What a client or page is told about the database it is connected to: its kind, and the language a demo speaks. */
export type InstanceFacts = { kind: InstanceKind; locale: Locale };
export const DEFAULT_INSTANCE: InstanceFacts = { kind: DEFAULT_INSTANCE_KIND, locale: Locale.enum.en };
