/** A row as a flow writes it: without the owner, which the scoped applier stamps. */
export type WithoutOwner<Row> = Omit<Row, 'userId'>;
