# ProofPowers Pay

Your AI agent pays vendors through PayPal, but only exactly what you approved. Poisoned invoices get blocked.

**Sandbox only.** No live PayPal keys. No real money. Keys come from env vars `PAYPAL_SANDBOX_CLIENT_ID` and `PAYPAL_SANDBOX_SECRET` only; never commit them.

## What it does

1. An AI agent reads sample invoices and proposes payments.
2. A deterministic gate (outside the model) checks payee allowlist, amount cap, due-date sanity, payee-change, and prompt-injection signals → PASS / HOLD / BLOCK.
3. The owner approves an exact payload. Approval is bound to a hash of that payload.
4. Only approved, unchanged payments go out through the PayPal sandbox; the batch ID is recorded in a ledger.

## Built with

- PayPal developer platform (sandbox Payouts)
- Node.js
- An LLM agent for invoice parsing and proposals (provider pluggable; demo ships with recorded outputs so `npm run demo` needs no paid API)

## Run (mock, no keys)

```bash
npm install
npm run demo
```

## Run (PayPal sandbox)

```bash
export PAYPAL_SANDBOX_CLIENT_ID=...
export PAYPAL_SANDBOX_SECRET=...
npm run demo:sandbox
```

## Tests

```bash
npm run test:gate
```

## Status

Early draft for the PayPal AI Hackathon eligibility check (Nov 5). Build, demo UI, and video land before the Nov 12 12:00 PT deadline.

## License

MIT
