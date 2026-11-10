# Release status

Offline regression: 122/122; stateless gate: 20/20. These passes do not constitute
a production security certification.

The November 10 v5 updates address the prior UI association race in `public/app.js`
(navSeq and discard of stale inspect/approval results) and proposal-cap reclamation
of expired OPEN and timed-out CONSUMING rows in `src/web.mjs`. Behavioral jsdom
tests cover delayed inspect and approve races, including BLOCK and HOLD cards,
ledger refresh after a stale approval, and status clear on navigation.

No real payment or production claim. The runnable path remains MOCK only.
Sandbox adapter code is present but inactive in the MOCK UI; `demo:sandbox` with
an empty environment returns HOLD and makes zero provider calls.
