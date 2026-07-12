# ADR-020: Transaction ownership by account type, not structural field-presence

**Status:** Accepted (2026-07-12; implemented as part of ADR-019 PR-2) · **Date:** 2026-07-12 · **Deciders:** Rafael · Revises **ADR-017**'s ownership
discriminator and refines **ADR-019**'s PR-2 logic re-homing. Surfaced while grounding ADR-019 PR-2: the
functions it planned to move (`isCardOwned`, `guardTransferMutability`) are cross-consumed, and the reason is
that the ownership rule itself sits in the wrong place.

## Context

ADR-017 made every write aggregate-specific and validated ownership with a **union rule**: a transaction is
credit-card-owned iff `cardId` **or** `billId` is set, else account-owned. This is implemented as a core helper
`isCardOwned(tx)` (reads `cardId`/`billId` off the shared `TransactionView`) behind a shared
`assertOwnership(existing, wantCardOwned, correctTool)` that both aggregates' update/delete tools call.

Two problems, both boundary smells:

1. **The core encodes an aggregate's row shape.** `isCardOwned`'s `cardId || billId` is the transaction core
   asserting "this is structurally what a credit-card transaction looks like" — the core knowing how the
   credit-card aggregate builds its rows. It is also a **field-presence heuristic**, not an authoritative check:
   it trusts denormalized hint columns rather than the canonical fact. The canonical fact already exists
   (ADR-010: a credit card **is** a `credit`-type account); ownership should be *resolved* from that, not
   sniffed from row columns.

2. **It forces the credit-card aggregate to know transfer rules.** Because the union rule routes the
   bill-payment transfer (`billId`, no `cardId`) to the credit-card aggregate, the card update path had to run
   `guardTransferMutability` (transfer type-immutable, no-category) — the credit-card domain reasoning about
   transfer invariants, which are not its concern.

The correct ownership question is a **domain** question each aggregate can ask authoritatively: *does this
transaction involve one of my accounts?* For the credit-card aggregate that means "does it touch a `credit`
account?" — which cleanly captures both card purchases (their account **is** the card's credit account) and the
bill-payment transfer (its destination `toAccountId` **is** the card's credit account), while excluding
everything else. `create_transfer` already forbids credit legs, so the only transaction reaching a credit
account as a destination is the system-made bill-payment transfer; "involves a credit account" is therefore
exactly "belongs to the credit-card domain."

Crucially the bill-payment transfer stays card-owned under this framing — it is not a user transfer that happens
to touch a card, it is a **credit-card/bill process artifact** whose transfer is merely the mechanism that moves
the money; ownership follows the process, not the mechanism.

## Decision (proposed)

**Determine ownership by account type, resolved per aggregate, not by a core structural discriminator. A
transaction belongs to the credit-card aggregate iff it involves a `credit` account (as source or destination);
otherwise it belongs to the account aggregate. Remove `isCardOwned` and the shared core `assertOwnership`; each
aggregate validates ownership as its own domain check. Transfer mutation rules live wholly in the account
aggregate; the credit-card aggregate never reasons about transfer invariants.**

1. **Per-aggregate ownership guards (replacing core `assertOwnership`):**
   - `update_card_transaction` / `delete_card_transaction`: resolve the transaction's account(s) and assert **a
     leg is a `credit` account**; otherwise reject with a redirect to the account tool.
   - `update_account_transaction` / `delete_account_transaction`: assert **no leg is a `credit` account**;
     otherwise redirect to the card tool.
   - The check reads the authoritative `AccountType` (ADR-010), not `cardId`/`billId`. `isCardOwned` and
     `assertOwnership` are deleted from the transaction core.

2. **Ownership outcomes are unchanged from ADR-017's union rule** — this is a mechanism/placement change, not a
   routing change:

   | Transaction | Union rule (`cardId`\|`billId`) | Account-type (involves `credit`) |
   | --- | --- | --- |
   | Card purchase/refund | card (`cardId`) | card (account is `credit`) |
   | Bill-payment transfer | card (`billId`) | card (`toAccountId` is `credit`) |
   | Regular transfer (bank↔bank) | account | account (no `credit` leg) |
   | Account expense/income | account | account (no `credit` leg) |

3. **The bill-payment transfer stays credit-card-owned, guarded by bill process — not transfer-immutability.**
   Its direct mutation is blocked by the credit-card aggregate's own rule ("this is a bill's payment
   transaction — use `revert_bill_payment`"), which is bill policy the card domain legitimately owns. The card
   aggregate therefore never invokes `guardTransferMutability`; blocking outright is a stronger guard than
   transfer-immutability anyway.

4. **Transfer mutation rules → account aggregate.** `guardTransferMutability` and the transfer mutation errors
   (`transferTypeImmutable`, `transferCategoryRejected`) move to the account context, consumed only by the
   account update — the only place regular (mutable) transfers exist. The credit-card aggregate stops knowing
   transfer immutability entirely.

5. **`resolveEffectiveType`'s transfer branch and the `transfer` row kind stay core** (ADR-019 sub-decision 3
   unchanged): balance/summary/`TransactionType` are the shared ledger, defined over the kind. Only transfer
   *policy* and *mutation invariants* are account-context.

## Options Considered

### Option A — Keep ADR-017's union rule / core `isCardOwned` (rejected)
The core encodes the credit-card row shape (`cardId || billId`) and validates ownership by field-presence rather
than the canonical account type; and it forces the card aggregate to run transfer-mutability checks on the
bill-payment transfer. The two smells this ADR removes.

### Option B — Ownership by account type, resolved per aggregate (chosen)
| Dimension | Assessment |
| --- | --- |
| Boundary | Core knows no aggregate's row shape; each aggregate asks its own domain question |
| Authority | Ownership resolved from `AccountType` (ADR-010 canonical), not denormalized hints |
| Transfer rules | Live only in the account aggregate; the card domain never reasons about transfers |
| Routing | Identical outcomes to the union rule (behavior-preserving) |
| Cost | An account-type resolution (a small read) on update/delete ownership checks |

### Option C — Move `isCardOwned`/`guardTransferMutability` into contexts as ADR-019 PR-2 literally stated (rejected)
Both are cross-consumed (the core `assertOwnership` uses `isCardOwned`; both the card update and the core/account
update use `guardTransferMutability`), so relocating them to a single aggregate creates `core → aggregate` /
`aggregate → aggregate` back-references. And it keeps the field-presence heuristic. It moves the smell instead of
removing it.

## Trade-off Analysis

The tension is **an authoritative domain check vs. a zero-lookup structural heuristic.** The union rule is free
(reads columns already on the row) but pays for it by putting credit-card row-shape knowledge in the core and
transfer knowledge in the card aggregate. Account-type resolution costs a small extra read on the
update/delete ownership check, and buys a boundary where the core knows no aggregate's shape, each aggregate
validates ownership from the canonical `AccountType`, and transfer rules live only where transfers live. Because
the routing outcomes are identical, the change is purely a boundary/robustness win at a tiny read cost — and the
read is optimizable later (e.g. the transaction read could carry its legs' account types) without touching the
decision.

## Consequences

- **Revises ADR-017.** The union-rule invariant (`docs/architecture.md` invariant #17) is rewritten to
  account-type ownership; ADR-017's sub-decision 4 gets a pointer to this ADR. Routing behavior is unchanged.
- **Removed**: `isCardOwned`, the core `assertOwnership`, and the core's use of `cardId`/`billId` as an
  ownership discriminator. Each aggregate gains its own account-type ownership guard.
- **Moved**: `guardTransferMutability` + `transferTypeImmutable`/`transferCategoryRejected` → account context.
- **Reframed (already true in effect)**: the credit-card aggregate blocks bill-payment-transfer mutation via its
  bill-process guard (redirect to `revert_bill_payment`), not via transfer-immutability.
- **Refines ADR-019 PR-2**: `isCardOwned` is *deleted* rather than relocated; `guardTransferMutability` → account
  (not core). The clean movers are unchanged: `assertBillPeriodPaired`/`withBillId` → credit-card,
  `resolveCurrency` → `logic/money.ts`.
- **The `wrongTool` redirect** stays a shared error primitive (a redirect hint naming a tool is not domain
  policy); each aggregate raises it from its own guard.
- **Behavior-preserving on routing**; the only user-visible surface is unchanged. Coverage-parity applies to the
  ownership-validation tests (same accept/redirect outcomes, now reached via account type).
- **Docs**: `docs/architecture.md` (invariant #17 rewrite + dependency-table note), `docs/mcp-tools.md` (the
  update/delete ownership descriptions phrased as account-type, not field-presence), ADR-017 amendment note.

## Migration

Fold into ADR-019 PR-2 (the logic re-homing PR), since they touch the same files:

1. Replace core `assertOwnership`/`isCardOwned` with per-aggregate account-type ownership guards (card: a leg is
   `credit`; account: no leg is `credit`), keeping the same redirect errors.
2. Move `guardTransferMutability` + transfer mutation errors → account context; remove them from the card update
   path (its bill-process guard already covers the bill-payment transfer).
3. Keep the clean movers (`assertBillPeriodPaired`/`withBillId` → credit-card, `resolveCurrency` →
   `logic/money.ts`).
4. Update `docs/architecture.md` invariant #17 + the ADR-017 amendment note; behavior-preserving, coverage-parity
   mapped.

## Action Items

1. [x] Review/accept this ADR (decision review — no implementation in this PR).
2. [x] On acceptance: add this ADR to the `docs/architecture.md` index, rewrite invariant #17 to account-type
   ownership, and add the amendment note to ADR-017.
3. [x] Implement as part of ADR-019 PR-2 (per Migration above) — behavior-preserving, coverage-parity mapped.
