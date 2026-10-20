export type Named = { id: string; name: string };

export type Resolution<T extends Named> =
  | { kind: 'found'; entity: T }
  | { kind: 'none'; query: string; candidates: string[] }
  | { kind: 'ambiguous'; query: string; candidates: string[] };
