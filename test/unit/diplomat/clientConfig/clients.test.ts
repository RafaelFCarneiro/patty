import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientConfigError } from '../../../../src/common/clientConfig.js';
import { readJsonOrEmpty } from '../../../../src/diplomat/clientConfig/clients.js';

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('readJsonOrEmpty', () => {
  let tempDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an empty object when the file does not exist', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'));
    expect(readJsonOrEmpty(join(tempDir, 'missing.json'))).toEqual({});
  });

  it('reports the underlying file read failure message', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'));
    const configPath = join(tempDir, 'config.json');
    mkdirSync(configPath);

    const exitSpy = vi.spyOn(process, 'exit');

    expect(() => readJsonOrEmpty(configPath)).toThrow(ClientConfigError);
    expect(() => readJsonOrEmpty(configPath)).toThrow(
      new RegExp(`^fintrack setup: failed to read ${escapeForRegExp(configPath)}: EISDIR:`),
    );
    expect(exitSpy).not.toHaveBeenCalled(); // it reports; the setup command decides what to do
  });

  it('treats an empty file as an empty object', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'));
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, '', 'utf8');

    expect(readJsonOrEmpty(configPath)).toEqual({});
  });

  it('falls back to an empty object for malformed JSON content', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'));
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, '{ invalid-json', 'utf8');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(readJsonOrEmpty(configPath)).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(
      `fintrack setup: ${configPath} does not contain a JSON object at the root — replacing it during setup.`,
    );
  });

  it('falls back to an empty object for non-object JSON roots', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'));
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, '[]', 'utf8');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(readJsonOrEmpty(configPath)).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(
      `fintrack setup: ${configPath} does not contain a JSON object at the root — replacing it during setup.`,
    );
  });
});
