# ProofPowers Pay — offline MOCK approval demo

**Recorded agent judgment → deterministic gate → exact human approval → MOCK ledger.**

The runnable path is **MOCK ONLY**, not a current PayPal payment or a live-model run.
Recorded agent decisions are labeled RECORDED. SQLite ledger batches are synthetic
MOCK IDs. No keys, internet, or real money are needed. There are no runtime npm
dependencies; tests require the jsdom devDependency, installed with `npm ci`.
Node.js 24.15+ provides `node:sqlite` (experimental warning on the verified version).
The project includes a CLI transcript and a loopback-only browser UI.

```sh
npm run demo
npm run test:gate
npm test
```

`demo` prints the inbox, evidence/source of the recorded agent decision, approval
payload/hash, mock payment result, replay, B1 rebill block, post-approval tamper
block, S09 poisoning flag, ledger and restart check. It creates a fresh OS temporary
directory for each rehearsal and prints the local `scene.html` path. The transcript
is escaped; invoice text cannot execute HTML or scripts. Open the file for a readable
scene-by-scene review. Approval is explicitly **synthetic**, not the owner's real yes.
The B1 replay fixture's PAY is labeled STAGED; it is not a new AI failure.

## Browser demo

Run `npm run start:mock` and open the exact loopback URL printed by the launcher.
Keep the MOCK banner and RECORDED labels visible. The launcher strips provider
variables and starts MOCK mode only. Stop with Ctrl+C. No hosted service is included.

## Evidence boundaries

- `spike/s3b_agy_guarded_1.out` is a supplied historical recorded agent output.
- Other `spike/` files are synthetic invoice/gate fixtures, not provider receipts.
- Historical sandbox payouts are not demonstrated or revalidated by this release.
- The 20 gate fixtures are regression cases, not population safety statistics.
- S09 detects this fixture's suspicious note. The keyword flag can be evaded;
  it is not general prompt-injection protection.
- An original request replay returns its existing MOCK result; the web UI also
  prevents approving an already-decided card. Neither creates another payout.

## Payment boundary and persistence

`src/gate.mjs` preserves the supplied historical gate/normNo logic. `src/pipeline.mjs` adapts the supplied pipeline_v3 design:
exact payload hash includes vendor/PO/payee/amount/currency/invoice/master revision;
explicit approval, expiry, agent PAY, recheck gate and master revision, then SQLite
`BEGIN IMMEDIATE` with independent UNIQUE PO, invoice_no and approval ID constraints.
Invoice and PO keys use the supplied normalization; invoice uniqueness is global
(more conservative than the spike's per-vendor constraint).

The same request replays its original mock batch, never a second transport. Different
invoices cannot consume a paid/reserved PO across restart or two processes. Unknown
transport outcomes remain UNKNOWN and HOLD across restart; no blind retry or automatic
reservation release. A mock batch is marked SUCCEEDED only on explicit mock success.
A future PayPal adapter must not treat the mere existence of a payout batch ID as
proof of completed recipient payment; it must reconcile actual batch/item statuses.

Vendor-master change requests need a one-use challenge, a distinct confirmer, and
an out-of-band channel tag. Revision changes invalidate old payment approvals. This
is a **synthetic local test contract**; no real authentication, independently verified
out-of-band identity service or secure production UI has been implemented. Do not
represent a supplied string as real identity proof.

## STEP 1 cumulative cap / remaining limits

**STEP 1 closes the existing T-split regression in the offline demo.** The existing
vendor.max is interpreted as a bound on all persisted USD ledger exposure for that
vendor, without a time reset. This is a conservative demo interpretation, **not
owner-approved real business policy**. Amounts and limits use integer cents; the
exact boundary passes. SUCCEEDED, RESERVED and UNKNOWN all count. Replay adds no
exposure, and neither new invoices nor new POs reset it. Distinct vendors have
independent bounds. Cap check and exposure insert share the existing SQLite
BEGIN IMMEDIATE reservation transaction, including across processes and reopen.

The additive payout_exposure table records vendor and cents per new reservation.
Pre-fix payouts contain hashes but no recoverable vendor/amount data. Any payout
without exposure blocks all new reservations with VENDOR_EXPOSURE_UNKNOWN, including
unrelated vendors, rather than guessing a backfill. Existing replay/HOLD and
PO/invoice dedup checks remain. No release, reconciliation, time window or production
migration policy is supplied. The original 20 stateless gate fixtures remain unchanged.
An unrecognized poisoning instruction may evade the keyword flag. No general fraud
or universal payment-safety guarantee is made.

## Sandbox boundary

Use **`npm run start:mock`** for this demo. Its launcher strips provider variables
and starts MOCK only. Do not use `demo:sandbox` for recording.

`npm run demo:sandbox` is **conditional**, not an unconditional no-network stub:
with default/insufficient configuration it exits HOLD (code 2, zero provider calls).
If sandbox mode, explicit opt-in, credentials and receiver readiness are supplied,
the command can create a sandbox payout through the adapter. No such invocation or
credential validation was performed in this release QC. No real money is used by
the MOCK demo. Sandbox readiness is not payment success or owner authentication.

## Running the checks

Install devDependencies once with `npm ci` before `npm test` (jsdom is required for
the UI race tests). Runtime scripts such as `demo` and `start:mock` do not need that
install. `npm test` runs the full suite and `npm run test:gate` runs the 20 stateless
gate fixtures. Final QC ran offline with `NODE_OPTIONS=--require=./scripts/offline-guard.cjs`
set explicitly; this process-level guard is not an OS firewall. `npm test` alone does
not install that guard. Node's test runner uses --test-isolation=none for compatibility
with the guard; forked concurrency and crash workers are separate processes and inherit it.

## What changed after 2026-10-01

This build reuses the earlier gate_v3, pipeline_v3 design and s3 fixtures. New work:
runtime-dependency-free CLI scenes, a separately injected mock transport, persistent exact
approvals and vendor revisions, SQLite atomic reservation, and restart plus two-process
regression tests.

License: MIT.

## Current regression coverage

The November 8 repairs are included: external-Origin session-creation rejection,
expiry revalidation after SQLite lock waits, and exact canonical approval-card
payload/hash agreement. Packaging/loopback-launcher regression tests are also included.
The November 10 updates address a UI association race (late inspect/approval results
are discarded when the selected invoice has changed) and reclaim expired OPEN and
timed-out CONSUMING proposal rows before the capacity count. The suite is 122 tests,
including jsdom behavioral coverage of delayed-fetch races (BLOCK and HOLD).
This is demo-scoped coverage, not a production security certification. Sandbox
adapter code is present but inactive in the MOCK UI. The final QC invocation of
`demo:sandbox` used an empty environment and returned HOLD; explicit sandbox
configuration can activate the conditional provider path described above.
Production owner authentication, reconciliation and business cap policy remain out of scope.
