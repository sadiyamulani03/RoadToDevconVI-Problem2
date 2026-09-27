# Problem 2: The Coin Purse — An Agent That Pays but Can't Be Drained

A research agent that can call paid **x402 HTTP endpoints** as a tool, with a
secure "coin purse" policy that prevents any endpoint/seller/tool from
draining its funds.

The LLM prompt is **NOT** the security boundary. Every payment decision is
made in executable code, against trusted configuration, with the cumulative
spend read from a persistent SQLite ledger.

---

## 1. Problem statement

Giving an AI agent a wallet is dangerous: a malicious seller (or a confused
model) can demand an excessive payment, a wrong network, a wrong asset, or
simply drain the purse. This project demonstrates an agent that can pay for
research over HTTP 402 (the x402 protocol) while a hard, auditable policy
refuses anything unacceptable **before the buyer signs or authorizes any
payment**.

## 2. Architecture

```text
Research agent (LLM tool-calling)
  ↓
paidFetch tool            (only the URL — no policy parameters)
  ↓
X402Client.paidFetch      (actual x402 SDK flow)
  ↓  402 response → { x402Version, error?, accepts: [...] }
PaymentService.decide     (select candidate by trusted allowlists)
  ↓
SpendingPolicy.evaluate   (the security boundary — pure decision logic)
  ├─ network allowlist            → REFUSE before signing
  ├─ asset allowlist              → REFUSE before signing
  ├─ exact integer parse          → REFUSE before signing
  ├─ per-call ceiling             → REFUSE before signing
  └─ total run budget (ledger)    → REFUSE before signing
  ↓
Persist decision to SQLite ledger   (BEFORE any signing)
  ↓ ONLY IF ACCEPTED:
createPaymentHeader(signer, …)  — real EIP-712 signature via the x402 SDK
  ↓
retry fetch with X-PAYMENT header — x402 protocol retry
  ↓
X-PAYMENT-RESPONSE header     — settlement outcome (transaction/receipt)
```

For a rejected payment the flow stops at the ledger: nothing is signed,
nothing is submitted, no second request is made.

## 3. Components

| Path | Responsibility |
| --- | --- |
| `src/agent/tools.ts` | Tool definitions for the LLM. `paidFetch` exposes **only** `url`; `getPurseStatus` is read-only. Handlers bind trusted config. |
| `src/agent/research-agent.ts` | LLM tool-calling loop (OpenAI-compatible) + deterministic offline planner when no API key is configured. |
| `src/agent/run-agent.ts` | CLI entry point for the agent. |
| `src/buyer/x402-client.ts` | The x402 payment flow using the **actual x402 SDK**: 402 → policy → sign → retry → settle header. |
| `src/buyer/payment-service.ts` | Orchestration: candidate selection by allowlists, policy evaluation, ledger persistence, signing bookkeeping. |
| `src/buyer/spending-policy.ts` | **The security boundary.** Pure decision logic, frozen config, bigint comparisons. |
| `src/buyer/money.ts` | Exact integer money helpers (`bigint` base units, no floats). |
| `src/ledger/schema.sql` | SQLite schema: every decision with reason, base-unit amounts, signing state. |
| `src/ledger/database.ts` + `ledger.ts` | SQLite bootstrap (WAL) and the ledger API. Cumulative spend is computed FROM the ledger. |
| `src/sellers/seller-kit.ts` | Shared seller server built on the actual `x402-express` `paymentMiddleware`. |
| `src/sellers/honest-server.ts` | Honest seller: requests $0.01 (10,000 base units) — within policy. |
| `src/sellers/rogue-server.ts` | Rogue seller: requests $10.00 (10,000,000 base units) — exceeds the ceiling. |
| `src/sellers/local-facilitator.ts` | Local facilitator implementing the x402 facilitator HTTP contract with genuine EIP-712 signature verification. |
| `src/config/config.ts` | Trusted configuration from the environment (never from tool arguments). |
| `src/demo/run-demo.ts` | End-to-end local demonstration (honest + rogue + attack + persistence). |
| `tests/` | 7 test files covering all 10 scored checks. |

## 4. x402 payment flow

The implementation uses the **x402 SDK v0.6.x** (npm packages `x402`,
`x402-express`) — the actual protocol, not a hand-rolled imitation:

- `402 Payment Required` response body: `{ x402Version, error?, accepts: [...] }`
- `selectPaymentRequirements(accepts, network, scheme)` from `x402/client`
- `createPaymentHeader(signer, x402Version, requirements)` from `x402/client` —
  builds and signs the EIP-3009 `TransferWithAuthorization` EIP-712 payload
  (domain `{ name, version, chainId, verifyingContract }` from the payment
  requirements' `extra`)
- Retry with the `X-PAYMENT` header (x402 protocol retry)
- Settlement outcome is returned by the seller in the `X-PAYMENT-RESPONSE`
  header and decoded with `decodeXPaymentResponse` from `x402/shared`
- Sellers use the actual `paymentMiddleware` from `x402-express`

The signer is created with `createSigner("base-sepolia", privateKey)` from
the x402 SDK. EIP-712 signing is an offline cryptographic operation; no RPC
is required for the buyer side. Verification and settlement are performed by
a facilitator (see below).

## 5. Spending policy

`src/buyer/spending-policy.ts` is the only place payment decisions are made.
It runs in executable code, its configuration is deep-frozen, and it is pure
decision logic — it has **no signing capability at all**. The LLM never sees
policy values and can never change them.

Checks, in order, all BEFORE any signing:

1. Network allowlist (`ALLOWED_NETWORK`)
2. Asset allowlist (`ALLOWED_ASSET`)
3. Exact integer parse of the quoted amount (base units, `bigint`)
4. Per-call ceiling: `quoted <= MAX_CALL_AMOUNT_BASE_UNITS`
5. Total run budget: `persistedSpend + quoted <= TOTAL_RUN_BUDGET_BASE_UNITS`

## 6. Per-call limit

`MAX_CALL_AMOUNT_BASE_UNITS` (default 1,000,000 = 1 USDC) is a hard ceiling
configured outside the tool arguments. The comparison is exact bigint
arithmetic in code. When a seller demands more than the ceiling (e.g. the
rogue seller's 10,000,000), the request is refused before signing.

## 7. Total budget

`TOTAL_RUN_BUDGET_BASE_UNITS` (default 5,000,000 = 5 USDC per run) is
checked before every payment against the **persisted** cumulative spend. If
`spend + amount` would exceed the budget, the payment is refused before
signing.

## 8. SQLite ledger

Every payment decision (ACCEPTED and REFUSED) is persisted in
`data/ledger.sqlite` (WAL mode) with:

```
id, timestamp, seller, endpoint, decision, reason, amount_base_units,
asset, network, payment_required, payment_signed, payment_submitted,
transaction_hash, run_id
```

Amounts are stored as exact decimal strings of bigint base units (SQLite
`SUM()` would cast TEXT to REAL, so the sum is computed in bigint from the
rows). The authoritative cumulative spend is always computed **from the
ledger**, so spending limits survive application restarts.

## 9. Network allowlist

Only explicitly approved networks may ever be paid
(`ALLOWED_NETWORK=base-sepolia`). A payment requirement for any other
network is refused before signing, no matter what a seller or the model
requests.

## 10. Asset allowlist

Only the explicitly approved payment asset may ever be paid
(`ALLOWED_ASSET`). For the Base Sepolia demonstration the asset is USDC
(`0x036CbD53842c5426634e7929541eC2318f3dCF7e` — the default asset built
into the x402 SDK, a public contract address, not a secret). An unsupported
asset is refused before signing. Asset validation happens before payment
authorization.

## 11. Integer base-unit handling

Money is never represented with floating point. All amounts are handled as
decimal strings or `bigint`:

- `1 USDC` (6 decimals) `=== 1_000_000n`
- x402 payment requirements quote amounts **already in base units**
  (e.g. `"10000"` = 10,000 base units = $0.01); they are parsed directly
  with exact integer parsing
- No `parseFloat()`, no `Number(amount)` for monetary comparisons
- Boundary comparisons (`quoted <= ceiling`,
  `spend + quoted <= budget`) are exact bigint semantics

## 12. Tool security

The `paidFetch` tool exposes only `url` (`additionalProperties: false`).
There is no `maxAmount`, `totalBudget`, `allowedNetwork`, `allowedAsset`,
`privateKey`, or `walletAddress` parameter. A model passing
`paidFetch({ url, maxAmount: "999999999999" })` cannot create a new spending
limit: unknown tool arguments are ignored, and the policy values live in
trusted configuration bound into the tool handler at construction time (and
are deep-frozen). The private key never passes through tool arguments or
agent messages; the tool returns only outcomes and refusal reasons.

## 13. Honest seller

A local HTTP service built on the actual `x402-express` `paymentMiddleware`.
It exposes `/reports/latest`, returns a standard x402 payment requirement
requesting $0.01 (10,000 base units of USDC on base-sepolia), and serves the
protected JSON resource after a valid payment.

## 14. Rogue seller

A separate local HTTP service that demands $10.00 (10,000,000 base units) —
far above the per-call ceiling. The buyer refuses it **before signing**. The
seller exposes a `/__seller-stats` endpoint so the demonstration can prove
by execution that the protected resource was never served and that zero
payments were verified or settled for the rogue seller.

## 15. Installation

```bash
npm install
```

## 16. Environment configuration

```bash
cp .env.example .env
# then edit .env with your own values (placeholders only in .env.example)
```

`.env` is gitignored. Never commit real credentials.

## 17. Running tests

```bash
npm test          # 48 tests across 7 files (all 10 scored checks)
npm run lint      # type check (tsc --noEmit)
npm run build     # compile to dist/
```

## 18. Running the sellers

```bash
npm run start:facilitator   # local facilitator (default port 4020)
npm run start:honest        # honest seller (default port 4021)
npm run start:rogue         # rogue seller (default port 4022)
```

Or run the full end-to-end demonstration (starts ephemeral servers itself):

```bash
npm run demo:honest         # honest + rogue + attack + persistence demo
npm run demo:rogue
```

## 19. Running the research agent

```bash
npm run agent -- --url http://localhost:4021/reports/latest
```

The agent uses the `paidFetch` tool (URL only). With `LLM_API_KEY` set it
uses an OpenAI-compatible tool-calling loop; without a key it falls back to
a deterministic offline planner that issues the same policy-enforced tool
call, so the demonstration runs without credentials.

## 20. Base Sepolia configuration

For a live testnet run, set in `.env`:

```env
PRIVATE_KEY=<your funded Base Sepolia testnet wallet private key>
ALLOWED_NETWORK=base-sepolia
ALLOWED_ASSET=0x036CbD53842c5426634e7929541eC2318f3dCF7e
FACILITATOR_URL=https://x402.org/facilitator
MAX_CALL_AMOUNT_BASE_UNITS=10000
TOTAL_RUN_BUDGET_BASE_UNITS=50000
```

The buyer side (402 → policy → EIP-712 signing → retry) works identically
against a live seller; the facilitator performs the on-chain settlement.
Without funded credentials/faucet access, do **not** claim a live run — the
local demonstration is the verification path (see below).

## 21. Security considerations

- **The LLM prompt is not a security boundary.** The policy is executable
  code; the model is never trusted to decide whether a payment is safe.
- **No credentials are committed.** `.env` is gitignored; `.env.example`
  contains placeholders only. Test private keys are generated at runtime.
- **Private key isolation.** `PRIVATE_KEY` is read from the environment
  only, never logged, persisted, exposed to the model, or passed through
  tool arguments. The local demo/agent generate a throwaway unfunded wallet
  when `PRIVATE_KEY` is absent (clearly labeled as such).
- **Seller-side determinism.** Demo pay-to addresses are derived
  deterministically from a label (not funded, not secrets). The local
  facilitator verifies EIP-712 signatures genuinely but does not broadcast
  on-chain transactions (no chain available locally); its settlement
  receipts are `local-<hash>` values, clearly NOT blockchain transaction
  hashes.
- **Audit trail.** Every payment decision is persisted with a reason before
  any signing.

## 22. Test results (local verification)

```
Test Files  7 passed (7)
Tests       48 passed (48)
```

| Check | Where |
| --- | --- |
| TEST 1 — x402 client payment mechanism | `tests/x402-client.test.ts` |
| TEST 2 — paid fetch as an agent tool | `tests/tool-security.test.ts`, `tests/x402-client.test.ts` |
| TEST 3 — rogue seller refused | `tests/rogue-seller.test.ts` |
| TEST 4 — no credentials in tracked files | secret scan + `.gitignore` + runtime-generated test keys |
| TEST 5 — per-call ceiling before signing | `tests/spending-policy.test.ts` |
| TEST 6 — cumulative budget before signing | `tests/spending-policy.test.ts` |
| TEST 7 — cumulative spend persisted in SQLite | `tests/ledger.test.ts` |
| TEST 8 — network + asset allowlists | `tests/allowlist.test.ts` |
| TEST 9 — tool cannot change spending policy | `tests/tool-security.test.ts` |
| TEST 10 — integer base-unit comparisons | `tests/integer-money.test.ts` |

## 23. Testnet result

**Local verification: completed** (all tests, build, and the honest/rogue
seller demonstrations pass — see `artifacts/demo-run-result.json`).

**Live Base Sepolia verification: not completed** — no funded testnet
wallet/credentials were available in this environment. No transaction hash
is claimed or fabricated; the local facilitator's `local-<hash>` receipts
are explicitly not blockchain transactions.
