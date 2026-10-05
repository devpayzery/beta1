# ArcadeVault audit notes

## Source of truth
`ArcadeVault.sol` is the source of truth for on-chain behavior. The current backend adds off-chain controls but does not claim to strengthen the deployed contract.

- `payToPlay()` is public and payable. It accepts any `msg.value > 0`, credits `epochPool[currentEpoch]`, and emits `Played(player, amount, epoch)`. The backend applies the separate `REQUIRED_PAYMENT_AMOUNT` rule.
- `recordScore(player, score, sessionId)` is callable only by `gameServerSigner`. It rejects the zero player and duplicate `sessionId` via `usedSessionIds`, appends to `epochScores[currentEpoch]`, and emits `ScoreRecorded(player, score, epoch)`. The contract does not validate payment ownership, score plausibility, epoch supplied by the caller, or gameplay evidence.
- `advanceEpoch()` is public after `epochDuration` (one day). It increments `currentEpoch`, resets `epochStart`, and emits `EpochAdvanced`.
- `claimPrize(epoch)` is public only for the winning player of a closed epoch. It copies and scans every score, selects the first strictly-highest score, marks the caller claimed, zeroes the pool, sends the full pool, and emits `PrizeClaimed`.
- `owner` alone can rotate `gameServerSigner`. There are no withdrawal or emergency-admin functions in the provided contract.
- `epochScores`, `epochPool`, `claimed`, `usedSessionIds`, `scoreCount`, `currentEpoch`, `epochStart`, and `epochDuration` are the available state/read surfaces in the supplied ABI.

## Off-chain vs on-chain

The server validates payment receipt, chain, destination, selector, amount, wallet, session state, gameplay duration/evidence, and duplicate HTTP submissions. The contract guarantees signer access control and one use per `sessionId`, but not the backend fee rule or gameplay authenticity.

## Contract limitations

1. `ScoreRecorded` omits `sessionId`, so event-only indexing cannot map a score to a session. Future deployments should emit `bytes32 indexed sessionId`.
2. `payToPlay` enforces only `msg.value > 0`; a future deployment should enforce a configured minimum if that rule belongs on-chain.
3. `claimPrize` performs an unbounded scan and first-highest tie resolution at claim time. Large epochs can become expensive and registration order decides ties. A future deployment should snapshot winner/prize at close or use an explicit bounded/aggregate mechanism.
4. `recordScore` accepts arbitrary scores from the authorized signer. Stronger integrity requires a future EIP-712 authorization containing sessionId, player, epoch, score, nonce, and deadline, verified on-chain.
5. The deployed contract stores `usedSessionIds`, but the current event still cannot prove which session produced a score.

## Final backend audit classification

- `FIXABLE_WITHOUT_CONTRACT_CHANGE`: request-size limits, atomic session transition, distributed rate limiting, persisted submission state, and safe reconciliation of a known transaction hash.
- `REQUIRES_CONTRACT_CHANGE`: signer-compromise containment, session-bound on-chain authorization, session-linked events, on-chain minimum fee, and bounded/O(1) prize resolution.
- `NOT_A_BUG / ACCEPTED_RISK`: trusted RPC availability and the fact that browser evidence is advisory rather than cryptographic proof.

If a submission is `submitting` and already has a transaction hash, a later finish request only waits for that hash and reconciles its receipt. If no hash was persisted after the send returned, the session remains `submitting` and is not retried automatically; an operational reconciliation worker must recover the transaction from the signer/RPC provider before any retry policy is introduced. The current provider interface cannot deterministically discover an unknown transaction from only the session payload, so no false recovery is implemented.

The submission policy tests cover the critical decision boundary with deterministic mocks: sent-with-uncertain-persistence stays pending, persisted `recorded`/`failed` scores complete a `submitting` session without receipt lookup, successful receipts become `recorded`, reverted receipts become `failed`, and reconciliation never calls `recordScore`. These are not real blockchain E2E tests.

The current contract should not be modified in this repository without a deployment/migration plan and compatibility review.

## ArcadeVaultV2 architecture

`contracts/ArcadeVaultV2.sol` is a separate deployment and does not alter the deployed `ArcadeVault`. V2 requires an exact `entryFee`, associates each payment with `(epoch, player)`, and rejects score publication without that payment. `recordScore` is authorized by EIP-712 (`SVP Arcade`, version `2`) over the contract address, chain ID, player, score, session ID, epoch, nonce, and deadline. The signer private key remains server-only.

V2 consumes both `usedSessionIds` and `(player, nonce)` exactly once. `ScoreRecorded` includes an indexed `sessionId`, and winner state is updated during recording. Ties retain the first score that reaches the maximum. `closeEpoch` freezes the winner and prize pool, marks the epoch closed, and starts the next epoch; `claimPrize` is O(1), uses checks-effects-interactions, and has a reentrancy guard.

When a submission has no persisted hash, the backend reads `usedSessionIds`. `false` remains pending and is never retried automatically. `true` is not treated as proof of a known transaction: without an unambiguous event/receipt the session remains a controlled reconciliation conflict and no hash is invented.

## V2 initial configuration and epoch economics

The single application configuration source is `lib/arcade-config.ts`: chain ID `2517`, initial entry fee `0.1` native token (`100000000000000000` wei), initial epoch duration `86400` seconds, and initial epoch ID `1`. `.env.example` mirrors these values through `CHAIN_ID=2517` and `REQUIRED_PAYMENT_AMOUNT=0.1`; `server-env.ts` rejects a different chain or payment amount. The frontend uses the same fee constant, while payment verification additionally reads the deployed contract's `entryFee` and requires exact equality.

`ArcadeVaultV2` snapshots `epochEntryFee[epoch]` and `epochDurationByEpoch[epoch]`. Administrative setters update `nextEntryFee` and `nextEpochDuration`; they do not alter the open epoch. `closeEpoch()` applies those pending values only to the newly started epoch. The constructor initializes epoch `1` at deployment timestamp with zero pool, zero winner, zero winning score, and no claim.

The constructor deployment parameters are `initialGameServerSigner`, `initialEntryFee`, and `initialEpochDuration`; the intended initial values are the server signer from protected environment configuration, `0.1` native token, and `86400` seconds on chain `2517`. The private key is never documented or embedded. EIP-712 uses `SVP Arcade`, version `2`, chain ID `2517`, and the deployed V2 address; the signed message includes player, score, sessionId, epoch, nonce, and deadline.

## V2 threat model and operational recovery

The contract protects against overpayment/underpayment, stale or replayed authorizations, wrong player/epoch/contract/chain signatures, duplicate sessions/nonces, unauthorized signer calls, closed-epoch writes, and prize reentrancy. It does not prove gameplay truth; the backend remains responsible for score validation and payment-receipt verification. A deployment must be verified against the emitted ABI, configured in `ARCADE_VAULT_ADDRESS` (and the client-facing address variable where required), and exercised on controlled testnet before production migration. The legacy contract must remain untouched until V2 testnet, event indexing, signer configuration, and recovery procedures are validated.
