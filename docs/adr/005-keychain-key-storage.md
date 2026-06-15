# ADR-005: OS keychain for encryption key storage

**Status:** Accepted · **Date:** 2026-06-15 · Companion to ADR-004 (libSQL encrypted local DB).

## Context

ADR-004 requires the libSQL database file to be encrypted at rest, with the key stored in the **OS keychain** (macOS Keychain / Windows DPAPI / Linux libsecret) — never beside the DB file. A copied `.db` file must be useless without the key; the local UX must be zero-prompt on every subsequent run.

This ADR covers the specific Node.js library used to read/write that key, plus the key lifecycle (generation, retrieval, rotation, CI override).

## Decision

Use **`@napi-rs/keyring`** for OS keychain access.

Key lifecycle:
- **First run**: generate a 32-byte cryptographically random key (`crypto.randomBytes(32).toString('hex')`), store it in the keychain under service `fintrack` / account `db-encryption-key`, then open the DB with that key.
- **Subsequent runs**: retrieve the key from the keychain; open the DB.
- **CI / headless override**: if `FINTRACK_DB_KEY` is set in the environment (64-char hex string), use it directly — no keychain read or write. This is also the documented recovery path if the keychain entry is lost.
- **Rotation** (out of scope for v1): export plaintext → generate new key → re-encrypt; documented as a future CLI command.

## Options Considered

### Option A — `keytar`

The original Electron keychain library; API: `getPassword(service, account)` / `setPassword(service, account, password)`. Cross-platform (macOS Keychain, Windows DPAPI, Linux libsecret via its native module).

**Pros:** Large install base, well-known API.  
**Cons:** Unmaintained since mid-2023; no new releases; open security issues unaddressed; GitHub repo archived by owner. Unacceptable for new code.

### Option B — `@napi-rs/keyring` — **chosen**

A Rust-backed NAPI-RS library with the same logical API as keytar (`Entry.new(service, account).getPassword()` / `.setPassword(password)`). Actively maintained under the napi-rs org; ships prebuilt platform binaries (macOS arm64/x64, Windows x64, Linux x64 musl/gnu) so no build toolchain is required at install time.

**Pros:** Active maintenance; Rust security foundation; prebuilt binaries for all target platforms; similar API surface to keytar (low migration cost if needed); works with `npx` installs.  
**Cons:** Smaller community than keytar (pre-1.0 API surface); NAPI native dependency to bundle (shared with libSQL — we already accepted this cost in ADR-004).

### Option C — Shell delegation (`security` CLI / `cmdkey` / `secret-tool`)

Spawn a subprocess to call the OS CLI tool for the keychain.

**Pros:** Zero Node native dependency.  
**Cons:** Cross-platform fragility; process-spawn overhead on every server start; potential injection surface if key names ever become dynamic; unacceptable for a security-critical path.

## Trade-off Analysis

The choice narrows to `@napi-rs/keyring` by elimination: `keytar` is archived, shell delegation is fragile. `@napi-rs/keyring` adds a native dependency, but that cost is already paid for libSQL (ADR-004). Both ship prebuilt binaries, so the user's machine needs no compiler.

The `FINTRACK_DB_KEY` env-var escape hatch means the keychain path is never mandatory for CI, Docker, or recovery — it is the **default** local path, not the only path.

## Consequences

- **Easier**: zero-prompt local UX; encryption key is invisible to the user on their own machine; a copied DB file is useless without the OS keychain entry or the env override.
- **Harder**: distributing a second native binary (`@napi-rs/keyring`) alongside libSQL; the keychain entry is tied to the OS user account — a new OS user or a fresh machine needs the env-var recovery path.
- **To revisit**: rotation CLI command; multi-profile support (multiple DB files with distinct keychain entries); Linux libsecret availability on minimal server images (env-var override is the workaround for now).
