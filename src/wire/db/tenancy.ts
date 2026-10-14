/**
 * A row as a flow writes it: everything but the owner. The owner (`userId`) is never part of what a controller
 * decides — the scoped applier stamps it on insert and confines every update and delete to it (ADR-033 §5) — so the
 * model→row adapters produce, and the row types of owned tables declare, this shape.
 */
export type WithoutOwner<Row> = Omit<Row, 'userId'>;
