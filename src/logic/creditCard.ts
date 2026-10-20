export const internalAccountNameFor = (cardName: string): string => `Card: ${cardName}`;

export const isCardRename = (currentName: string, newName?: string): newName is string =>
  newName !== undefined && newName.toLowerCase() !== currentName.toLowerCase();
