/** Pure credit-card aggregate rules. */

/** The card's internal liability account is always named `Card: {cardName}` (ADR-010) — the one
 *  place this naming convention is defined; every read/write of that name goes through here. */
export const internalAccountNameFor = (cardName: string): string => `Card: ${cardName}`;

/** True when `newName` is provided and differs from `currentName` case-insensitively — the
 *  precondition for a card rename (and its cascading internal-account rename), consistent with
 *  `updateAccount`'s case-insensitive rename check (Feature Design 007). A type predicate: narrows
 *  `newName` to `string` on the caller's `if`, so a case-only change (which skips this) still lets
 *  the caller write the new casing without re-checking name availability against itself. */
export const isCardRename = (currentName: string, newName?: string): newName is string =>
  newName !== undefined && newName.toLowerCase() !== currentName.toLowerCase();
