/** Pure credit-card aggregate rules. */

/** The card's internal liability account is always named `Card: {cardName}` (ADR-010) — the one
 *  place this naming convention is defined; every read/write of that name goes through here. */
export const internalAccountNameFor = (cardName: string): string => `Card: ${cardName}`;

/** Case-insensitive, so a case-only change (e.g. "nubank" → "Nubank") is not treated as a rename —
 *  gates the name-availability guard, which would otherwise self-collide against the name's own
 *  current casing. */
export const isCardRename = (currentName: string, newName?: string): newName is string =>
  newName !== undefined && newName.toLowerCase() !== currentName.toLowerCase();
