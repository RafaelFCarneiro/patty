import { describe, expect, it } from 'vitest';
import { USER_SETTINGS_ENTITY_TAG } from '../../../src/models/locale.js';
import { loadFragment } from './fragment-sandbox.js';

// budget.html defaults its display currency to the base currency; a userSettings event must move that default
// unless the person already picked a currency (the shell has refreshed window.BASE_CURRENCY by then).
const loadBudget = () => loadFragment('budget').sandbox;

describe('budget.html display currency on a userSettings event', () => {
  it('follows the new base currency while the person has not chosen one', () => {
    const sandbox = loadBudget();
    sandbox.BASE_CURRENCY = 'USD';
    sandbox.onAppDataChanged([USER_SETTINGS_ENTITY_TAG]);
    expect(sandbox.currentDisplayCurrency).toBe('USD');
  });

  it('still follows the base currency after only the month or year changed', () => {
    const sandbox = loadBudget();
    sandbox.onFilterChange();
    sandbox.BASE_CURRENCY = 'USD';
    sandbox.onAppDataChanged([USER_SETTINGS_ENTITY_TAG]);
    expect(sandbox.currentDisplayCurrency).toBe('USD');
  });

  it('keeps a currency the person chose', () => {
    const sandbox = loadBudget();
    sandbox.onCurrencyChange();
    const chosen = sandbox.currentDisplayCurrency;
    sandbox.BASE_CURRENCY = 'USD';
    sandbox.onAppDataChanged([USER_SETTINGS_ENTITY_TAG]);
    expect(sandbox.currentDisplayCurrency).toBe(chosen);
  });

  it('ignores a base currency the instance does not know', () => {
    const sandbox = loadBudget();
    sandbox.BASE_CURRENCY = 'XYZ';
    sandbox.onAppDataChanged([USER_SETTINGS_ENTITY_TAG]);
    expect(sandbox.currentDisplayCurrency).toBe('');
  });
});
