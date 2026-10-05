# AGENTS.md

Web3 arcade game. Next.js 16 (App Router, Turbopack) + React 19 + Supabase (Postgres) + viem/wagmi, on **SVP Chain testnet (chain ID 2517)**.

## Commands

pnpm only (`packageManager` is pinned; use `pnpm-lock.yaml`, never npm/yarn).

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm lint        # eslint .            — fast
pnpm typecheck   # tsc --noEmit        — ~100s
pnpm test        # vitest run          — 7s, 145 tests
pnpm verify:migrations              # PGlite: applies every migration, 68 checks
pnpm compile:contracts              # solc 0.8.24 over every contracts/*.sol, 7 contracts
pnpm build       # next build          — ~2min (22s compile + 97s TS)
```

Run `lint` → `typecheck` → `test` → `verify:migrations` → `compile:contracts` before claiming a change is done. **There is no CI** — nothing else enforces this, and nothing checks that the migrations match a live database.

`verify:migrations` exists because of a class of bug that survives `typecheck`, `test` and `build`: **a trigger referencing a function defined later in the file applies cleanly and only fails the first time someone writes to the table.** Postgres does not validate the function exists when the trigger is created. PGlite catches it; `tsc` never will.

`compile:contracts` (`contracts/compile-check.mjs`) exists because **no JavaScript tool reads a `.sol` file** — `tsc`, `eslint` and `vitest` all pass with a contract that does not compile. It drives `solc` 0.8.24 through `--standard-json` and **needs network on the first run** to fetch solc via `npx`; without it the script fails loudly rather than reporting a pass it did not verify. Two settings are load-bearing: `evmVersion: cancun`, because OpenZeppelin 5.6.1 uses `mcopy` in `Bytes.sol` and 0.8.24 defaults to `shanghai`; and `optimizer.runs: 200`, matching the documented options in `lib/*-abi.ts`. **It is not a contract test**: no invariants run, no fuzzing, no deployment. Foundry is still owed.

**Windows/PowerShell quirk:** `pnpm <script>` wraps the real command and prints `pnpm.exe : $ tsc --noEmit` + `NativeCommandError` noise to stderr even on success. It is **not** a failure. To get a trustworthy code, bypass the wrapper: `npx tsc --noEmit; $LASTEXITCODE`.

Focused test run:
```bash
npx vitest run tests/arcade.test.ts -t "gameplay validation"
```
`vitest.config.ts`: `environment: 'node'`, `include: ['tests/**/*.test.ts']`, alias `@` → repo root. Two test files exist; they cover pure logic only — **no route, DB, or component tests**.

## Architecture

Play flow, all server-authoritative:
1. Client sends `payToPlay(uint8)` on-chain itself, for the arena it picked. Entry is 0.1 / 0.5 / 1.0 SVP per arena; the amount actually charged is re-read from the chain in `verifyPayment`, not trusted from the client.
2. `GET /api/play` — verifies receipt, chain, destination, selector, amount → persists `arcade_payments` **including its `arena_type`** → creates `arcade_sessions` (TTL 60s, 32-byte random `sessionId`).
3. `POST /api/play/finish` — validates gameplay evidence against the session's arena rules, recomputes score, then the **server signs EIP-712** with `GAME_SERVER_PRIVATE_KEY` and calls `recordScore`.
4. Server then mints VYNAR (`mintForScoreOnce`). **The `points` argument is `vynarPoints`, not the score.** They are the same number only when no booster was used; see "The booster is 2x on VYNAR and never on points" below.

The server is the only `gameServerSigner`. `closeEpoch` and VYR publishing are cron-only, gated by `CRON_SECRET` (`app/api/cron/*`, `app/api/incentive/publish`).

**Directory ownership**
- `lib/` — server logic. These carry `import 'server-only'` and must never be imported from a client component: `server-env`, `rpc-manager`, `server-blockchain`, `session-store`, `supabase/admin`, `rate-limit`, `reward-finalization`, `server-log`, `wallet-auth`, `booster-store`. `cron-auth` takes the secret as a param instead. `booster-validation` is the pure half and vitest imports it.
- `app/api/` — one folder per route, `export const runtime = 'nodejs'`.
- `lib/arcade-arenas.ts` — **the only** source of truth for arena ids, entry fees, protocol-fee bps, gameplay rules, shield rules and booster rules (`BoosterRules`), plus the branded `VynarPoints`. Pure module (no `server-only`, no env, no DB) so vitest can import it. Import from here, never from an ABI file and never as a literal.
- `lib/arcade-vault-v6-abi.ts` — the **current** vault ABI. `lib/vynar-rewards-v3-abi.ts` the rewards one. `lib/arcade-vault-v5-abi.ts` and `lib/arcade-vault-abi.ts` are superseded and imported by nothing.
- `supabase/migrations/` — **the only** source of DB truth. `supabase/schema-complete.sql` is a *derived* from-scratch provisioning script; regenerate it from the migrations, never treat it as primary.
- `contracts/` — see below. Mostly *not* what runs.

## The contracts in `contracts/` are NOT what runs

This is the single easiest thing to get wrong. `contracts/ArcadeVaultV2.sol`, `VynarDistributor.sol` and `Vynar.sol` are superseded. The app actually calls **`ArcadeVaultV6`** and **`VynarRewardsV3`**, whose Solidity source is **not in this repo** — only ABIs (`lib/arcade-vault-v6-abi.ts`, `lib/vynar-rewards-v3-abi.ts`). The production `.sol` files live outside the repo, in the user's Downloads; `contracts/ARCADE-V6-NOTES.md` is the migration record.

`contracts/Vynar.sol` exposes only `mint(address,uint256)` and `setMinter`; the app calls `mintForScoreOnce` and `scoreRewarded`, which do **not** exist in that file.

Never "fix" a contract issue by editing `contracts/*.sol` — you would be changing dead code. Do not fabricate a source you have not verified.

The exceptions, i.e. the four contracts that are the current design and that `compile:contracts` checks: `ArcadeVaultV6.sol`, `VynarRewardsV3.sol`, `StakingVault.sol` (all Etapa 0) and **`BoosterVault.sol`** (Etapa 6). `BoosterVault` compiles and is the intended design, but it is **not deployed and not wired**: there is no ABI in `lib/`, no env var, and no route that calls it. Do not assume it runs.

## The booster is 2x on VYNAR and never on points

Three facts make this true structurally rather than by convention, and each one was a design decision, not a coincidence.

**1. The two numbers travel in two different transactions.** `recordScore(player, score, ...)` fixes the leaderboard, the epoch prizes and every ranking view. `mintForScoreOnce(to, points, rewardId)` fixes the wallet. The server passes `score` to the first and `vynarPoints` to the second, and **only the second carries the multiplier**. There is no factor argument on `recordScore` and the vault has never heard of boosters, so a booster cannot move a leaderboard position even if the mint code is wrong. `arcade_scores.vynar_points` is deliberately absent from `arcade_scores_ranked`, `arcade_scores_best` and `arcade_leaderboard_public`.

**2. `mintForScoreOnce` is one-shot per `rewardId`, so the 10-second window has to be per-click.** `rewardId` is the `sessionId`, one mint per round, `amount = points * pointsPerToken / BASIS`. There is no way to stream VYNAR over time, so "the 2x lasts 10 seconds" cannot mean a multiplier that decays — it means the clicks inside `[activation, activation + 10_000)` are worth 2x in VYNAR and the rest are worth 1x. The window is half-open, left-closed right-open, identical to `shieldActiveAt`, for the same reason: two activations exactly `durationMs` apart must not overlap by a millisecond. **Windows never stack** — `boosterActiveAt` returns a boolean, not a count, so two overlapping activations give 2x and never 4x.

**3. `score` and `vynarPoints` are branded differently on purpose.** Both are `number`, so `VynarPoints` is a nominal type (`lib/arcade-arenas.ts`) and `submitScoreFromServer` / `recoverScoreMint` take named objects. Passing `score` where `vynarPoints` belongs is a real bug that was verified to compile cleanly with positional args and no route tests. The brand stops a `number`; it does **not** stop `pending.data.score`, because PostgREST returns `any`. That hole is covered by `asVynarPoints` being the only cast in the repo plus the immutability trigger on the column.

`lib/booster-validation.ts` is pure (no `server-only`, no env, no DB) so vitest can import it. `lib/booster-store.ts` holds the paid entitlement and is `server-only`.

**Absence is not a free booster.** `boosterActivations` absent, `null` or `[]` all mean "I did not use it", and the total is then exactly the score. Same reasoning as `shieldActivations`, and the field is optional in `GameResult` because absence is a legitimate wire value for every client older than the mechanic. It is declared optional there, and required for the shield, because the shield case no longer occurs while this one does.

**One unit per activation, and the unit check is the only thing that makes it paid.** `boosterValidationError(activations, rules, availableUnits)` rejects with `booster_no_units` when the client declares more activations than it bought, and `availableUnits` comes from `arcade_booster_units` — never from the request body. Units are consumed with a compare-and-set on `status = 'available'` plus a trigger that forbids re-consuming, so two concurrent `Finish` calls cannot both spend the last unit.

**What Etapa 6 still does not have:** the purchase route. Nothing creates `arcade_booster_units` rows yet — no HTTP 402, no EIP-3009 signature collection, no `lib/booster-vault-abi.ts`. The mechanic is complete and tested on the server side and unreachable from the client. Buying a unit is the next piece, and it needs the BoosterVault ABI and a `NEXT_PUBLIC_BOOSTER_VAULT_ADDRESS`.

**The shield and the booster compose, and that is the point.** The shield answers "did this click score" (and can turn a miss into a full hit); the booster answers "is that value doubled". A miss rescued by the shield inside the booster window is worth double. Both are 10s, so in `hard` (20s rounds) they compete for the same first half of the round — the booster amplifies the shield's coverage rather than replacing it.

There is **no `cannotActivateAfterMs`** on the booster, unlike the shield. The shield is free and part of the arena's balance, so activating it late is wasted time the server can refuse to accept; the booster is paid for, so a deadline would only punish the buyer. Late activation is already self-limiting: click value decays, so doubling the first second beats doubling the last.

`V6_EIP712_DOMAIN` is still `{ name: 'VerityArcadeV5', version: '1' }`. That is deliberate: the string is part of the signature payload already signed on-chain for V5, and changing it would invalidate every signature. Do not "tidy" it to V6.

## Reading multi-output contract returns: ALWAYS by position

This is the highest-yield trap in the repo and it has bitten twice. Never read a named output off a viem return.

**Trap 1 — viem does not preserve ABI output names.** `viem` delegates to `abitype`, whose `unwrapName` resolves each output name against `AbiParameterTupleNameLookup`: a generated list of ~1500 identifiers scraped from real-world ABIs. A name **in** the list keeps its label; a name **not** in it falls through to the index signature `Record<string, [type]>` and comes back as `[type]` **unnamed**. In this repo `pool`, `active`, `paused` and `bps` are in the list and survive; `currentEpoch`, `epochEnd`, `entryFee`, `secondsLeft`, `winners`, `winnerCount`, `closed` and `prizePool` are not. So `result.closed` may typecheck at one call site and `result.prizePool` will not — and a single `as` silences both.

**Trap 2 — viem rewrote return shapes without renaming.** `epochResults` in V5 returned `[prizePool, closed]`. In V6 it still exists and returns **eight** fields, reordered, with `closed` at index 5. Porting `epochResults(...)[1]` compiles, runs, and yields `prizePool` — a bigint in a boolean slot, which is truthy, so an open epoch reads as closed. There is no error and no log. The app uses `getEpochResult` (9 outputs, includes the frozen `bps`) precisely because of this, and `tests/arcade.test.ts` pins both shapes.

Rule: destructure **positionally with local names**, in one place per contract, and let the ABI output names serve as the comment. `readArena()` in `lib/server-blockchain.ts` is the model.

## Arena ids: the numeric id is load-bearing

`ARENA_IDS` in `lib/arcade-arenas.ts` must match `enum ArenaType` in `ArcadeVaultV6`: `HUMAN, MEDIUM, HARD, AGENT` = 0, 1, 2, 3. **AGENT moved from 1 to 3.** Any persisted id that meant `agent` now means `medium`, and a score signed for one arena would be filed under another with the prize paid to the wrong player.

The SQL side is just as unforgiving: `svp_epoch_snapshots.arena`, `svp_reward_allocations.arena` and `vyr_chain_snapshots.arena` store the on-chain id in `smallint`, so `20261002000000_arcade_v6_arenas.sql` includes a **mandatory data migration** (`1 → 3`), not just new constraints. The `text` columns (`arena_type`) are unaffected — under V5 only `human` existed, so every backfilled row is `'human'`.

`arcade_payments.arena_type` (`20261002000100`) is not redundant with the session: it is what proves the entry bought that mode. Two triggers hold the chain of custody — `arcade_sessions_arena_matches_payment` (session mode must equal payment mode) and `arcade_payments_arena_no_update` (payment mode is immutable, or the first trigger could be invalidated silently).

V6 freezes `svpBps[]` at close over the populated slots (1 player = 100%, 2 = 70/30, 3 = 70/20/10), so the app **reads bps from the chain** via `getEpochResult`. `SVP_PERCENTAGES` is gone; do not reintroduce a client-side table of percentages.

The fee is flat 0.02 SVP per entry in all three modes, reproduced with different bps per price (2000 / 400 / 200). All must stay under `MAX_PROTOCOL_FEE_BPS = 3000` or `setProtocolFee` reverts and the deploy breaks.

## The arena a page is showing lives in the URL, and freezes at session creation

`?arena=` accepts the name (`medium`) and the numeric id (`1`); `parseArenaParam` normalizes case and whitespace and returns `undefined` for anything not playable, `agent` included. One component renders it everywhere: `ArenaTabs` (`components/arena-tabs.tsx`), used by the home, `/play`, `/leaderboard` and `/incentive`. Do not add a second selector — a per-page copy is how a mode ends up added to the registry and missing from one surface.

**Invalid must not fall back to `human`.** Absent is legitimate and resolves to `human`; present-but-unknown is an error, and `/play` says so and blocks entry (`arenaInvalid` feeds `entryOpen`). The distinction exists because a silent fallback charges 0.1 SVP for a round the player asked to play in another mode. That is why `parseArenaParam` returns `undefined` for both cases instead of defaulting internally: the caller has to make the choice.

Three invariants hold the mode together, and each one exists because its absence produced a specific failure:

1. **Once a session exists, the mode is frozen to what the server returned** (`data.arena` → `sessionArena`), and the URL stops governing. `/api/play/finish` validates against `arenaByType(session.arena)`, not against the request. If the client kept following the URL, opening `/play?arena=human` during a `hard` round would have the client sign with human's formula (bonus 10, 30s decay) while the server recomputes with hard's (bonus 15, 15s) — a 422 'invalid score' on a legitimate round, indistinguishable from fraud.
2. **The pending payment is stored with its mode**: `sessionStorage['verityarcade.payment']` = `{"tx":"0x…","arena":"medium"}`. Only the hash used to be kept, so a reload of `/play?arena=medium` after paying human re-requested a medium session with a human payment. The trigger rejects it (no double charge, no lost money) but the player sees a 409 unrelated to the payment they made. The legacy `verityarcade.paymentTx` key is still read, and necessarily resolves to `human` — it never recorded a mode.
3. **On recovery the stored mode wins over the URL.** `requestPlay(payment, paymentArena)`: the player paid, so they get that round. The same applies right after `pay()` confirms — `requestPlay(hash, ARENA.type)` — so a URL edit mid-payment cannot change which mode is requested.

`/api/play` is the only route that takes the mode from the query. `/api/play/finish` and `/api/play/confirm` both derive it from the session and must keep doing so.

**`useSearchParams` requires a Suspense boundary.** `/play`, `/leaderboard` and `/incentive` wrap their client component in `<Suspense>`; without it the route cannot be prerendered and the build fails. The home needs none: `app/page.tsx` is `force-dynamic`.

**Three of the six mode literals were on the score path** — `verifyScoreRecorded(..., { arena: 0 })` on both the finish and confirm routes, and `expectedScore(validResult)` with the `arena` argument omitted. All three are gone: `expectedScore` now takes a required `arena`, and both `verifyScoreRecorded` calls pass `arenaByType(session.arena).id` behind an unknown-arena guard. The default argument was the trap — all three callers already passed it, and having to pass it is what makes the omission visible next time.

**Which routes filter by mode, and which return every mode on purpose.** The distinction is not stylistic, and assuming a route filters when it does not is how the wrong mode's data ends up under a tab:

| Route | `?arena=` | Behaviour |
| --- | --- | --- |
| `/api/play` | reads it | resolves before the 402, so the price announced is the requested mode's |
| `/api/play/finish`, `/api/play/confirm` | ignores it | arena comes from the session; the client must not send it |
| `/api/leaderboard` | **requires it** | 400 without it |
| `/api/incentive/rewards` | reads it | filters `vyr_claims_wei` and `arcade_scores_best` by `arena_type` |
| `/api/incentive/claim-status` | reads it (GET query, POST body) | filters by `arena_type`; the POST body must carry it or the claim row is filed under `human` |
| `/api/incentive/my-rewards` | ignores it | returns **all** modes, every row labelled with `arenaType`; the page filters |
| `/api/incentive/epochs` | ignores it | returns **all** modes, every row labelled with `arena`; the page filters |
| `/api/history` | ignores it | per-wallet across all modes, each row labelled with `arena_type` |

For the two all-mode routes, the server already keys its maps by `(epoch, arenaType)` — keying by epoch alone lets one mode's row overwrite another's with no error. `app/incentive/page.tsx` filters both responses client-side, and that filter is load-bearing, not cosmetic: without it the `medium` tab lists `human` prizes and `claimPrize` is signed with the wrong id.

**Hardcoding a mode name is the defect that kept recurring.** Six instances survived the whole V6 migration: `verifyScoreRecorded(..., { arena: 0 })` on both the finish and confirm paths, `expectedScore(validResult)` with `arena` omitted, `claimPrize(ARENA_IDS.human, …)` on the incentive page, and `.eq('arena_type', 'human')` twice in `/api/incentive/rewards`. Grepping for `ARENA_IDS.human` finds none of the last two — there the literal is a string inside a query, not the registry symbol. Sweep for *comparisons against a mode name* (`.eq('arena_type', '…')`, `arenaType: '…'`, `args: [0]`), not for a specific identifier.

The one remaining mode literal in `app/` is deliberate: `readStoredPayment()` falls back to `human` for the legacy `verityarcade.paymentTx` key, which never recorded a mode and predates every arena but `human`.

## The click stream is clicks, not hits, and that moved a defence

`GameResult.events` are **clicks**: `{atMs, x, y}`. The server decides hit or miss by comparing each click against the target derived from `gameSeed` for **that click's index** (`classifyClicks`). The client never declares the outcome, which is what stops it declaring a hit where it missed.

Until Etapa 5 this was not true and the difference is worth knowing, because it is the kind of change that reads as a simplification:

- `hitTarget` used to take no click position at all. It wrote `{ x: target.x, y: target.y }` — the *target's* position — so **a miss was impossible by construction** and every event scored. That is also why `gameplay.targetTolerance` was inert: nothing was ever compared against it, so the field could be any number at all.
- `target_mismatch` used to reject any stream whose positions were off-target. It cannot be a rejection gate once misses are legal, because a miss *is* being off-target. The check moved into `classifyClicks`, inside `expectedScore`, where it decides how much each click is worth. **The defence against a forged score did not disappear, it moved**: `app/api/play/finish` rejects on `claimedScore !== expected`, and a stream of 60 off-target clicks declaring `MAX_SCORE` recomputes to near zero.
- Two tests changed sense because of this, both rewritten rather than deleted: `un atacante que clica fuera de la diana ya no gana puntos` and `trata los clics fuera de diana como fallos, no como intento de fraude`. The second one is the honest one — five clicks off-target declaring `score: 0` is a *bad round*, not fraud, and rejecting it would be punishing sloppiness instead of lying.

**`targetTolerance` is a percentage of each dimension, not of a radius.** It is compared as `|event.x - target.x| <= t` with `x` as a percentage of the playfield's **width** and `y` of its **height**, so the scoring zone is an **ellipse** whose shape depends on the viewport. On a 700×450 playfield, `human`'s 6 is 42px across and 27px down. The UI honours this by giving the target `width: 2t%` and `height: 2t%`, which produces exactly that ellipse with no measuring — measuring and converting to pixels would create a second definition of the zone that the server does not share. The old `size-12` circle was 48px, i.e. **larger than the real scoring zone**, so clicking what you could see could score nothing. Do not reintroduce a fixed pixel size for the target.

6/5/4 (up from 4/3/2) reaches the 44px touch-target guidance in both axes on desktop only. It cannot reach it on a narrow phone: the short axis there is the width, and 44px would need a tolerance of 13, whose 26% diameter overlaps nearly every reachable centre in `targetRange` (12..88) and turns the game into "almost everything hits". This is a property of expressing tolerance as a percentage, not a tuning oversight; the numbers, the measured table and the alternative (declare the playfield at session creation, never in the result) are all in the `targetTolerance` comment in `lib/arcade-arenas.ts`.

## The shield: what it protects, and the three things that are easy to get wrong

`gameplay.shield` had four rules and **no effect** until Etapa 5 — it was four fields nobody read. Now:

- **A miss scores 0.** That is the penalty, and the shield makes a click score in full while active. It is deliberately not a fixed deduction: a `missPenalty` constant would have been a guess, "worth zero" is fully determined by values already in the registry, the score can never go negative, and `maxScoreForRules` and the `score >= 0` bound stay untouched.
- **`GameResult.shieldActivations` absent means "did not use it", never "used one free".** An older client omits the field and must still be able to finish a `human` round; a 422 on a legitimate round is the failure this repo has spent five stages removing. `expectedScore` reads `?? []` and `shieldValidationError` treats `undefined`/`null` the same way, for the same reason.
- **An activation cannot retroactively cover an earlier miss.** That is what makes the field a list of timestamps rather than a boolean, and it is why the window is checked per click. Activating at 3s covers a miss at 4s; activating at 9s does not.
- The window is `[activation, activation + durationMs)` — closed left, open right. The right-open edge stops two activations `durationMs` apart overlapping by a millisecond and making the cooldown incoherent with the duration.

The shield does **not** make the target a booster: a booster multiplies VYNAR and never touches points, whereas the shield only stops a miss from being worth less than it was. Keyboard play (Space/Enter anywhere) always counts as a hit on the current target, because a miss is "clicked somewhere else" and with a keyboard there is no somewhere else. That preserves play without a pointer; it opens no hole, since an attacker can already declare a perfect 60-click stream.

Two related fixes fell out of this and should not be undone:

- **`expectedScore` now takes the seed, required.** It could not classify without it, and a missing seed must not mean "every click hit" — that is the maximum score. Both call sites genuinely have one. `/api/play` with an invalid seed now **refuses to start the round** instead of falling back to a fixed centre target where every click scored; that fallback was a free 24000.
- **`/play` declares activations through a `pointerdown` on the playfield, and the target is `pointer-events-none`.** A separate `onClick` on the target made off-target clicks unrecordable. The shield button carries `data-game-control` and the global Space/Enter handler skips it, or activating the shield with Space would also register a hit.

## Docs are audit records, not current documentation

`docs/ArcadeVault-audit.md` and `docs/v3-contract-audit-status.md` describe **V3/V2** behaviour. Code is on **V6**. Treat any claim there about current behaviour as stale; trust the code and the ABI.

Known limitations they *do* correctly flag, and which are still true:
- No cryptographic anti-cheat. The client declares the click stream; the server checks shape, bounds, formula, a minimum inter-event interval and seed-derived targets (`lib/score-validation.ts`). That raises the bar substantially — it is not proof, because `gameSeed` is transmitted to the client. Note the specific consequence: a client that wants a maximum score simply does not declare its misses, exactly as it could already decline to declare unhelpfully-timed clicks. A miss is self-penalising for an honest player and free to omit for an attacker. The part that *is* enforced is that you cannot declare misses and then pop the shield to erase them.
- `docs/*` is explicitly not a place to claim stronger guarantees.

## Wallet authentication

Endpoints exposing per-wallet data (`/api/history`, `/api/incentive/{my-rewards,rewards,claim-status}`) require a signed session cookie. There is no opaque server token; the cookie is an HMAC over the signing wallet.

1. `POST /api/auth/challenge` `{ wallet }` → `{ message, nonce, issuedAt }`, message rebuilt server-side.
2. Client signs the message with EIP-191 and calls `POST /api/auth/session` `{ wallet, nonce, issuedAt, signature }`.
3. Server verifies the signature against `wallet`, then atomically consumes the nonce via `consume_arcade_auth_challenge` (`UPDATE ... WHERE consumed_at IS NULL` is the single-use guarantee), and issues an httpOnly cookie.
4. `requireWalletSession()` (`lib/wallet-auth.ts`) gates every wallet-scoped route. It **fails closed**: no `WALLET_AUTH_SECRET` (or one under 32 chars) ⇒ `AUTH_UNAVAILABLE`, never an open route.

`lib/auth-challenge.ts` holds the pure message/nonce logic and `lib/wallet-auth.ts` the server-only signing. That split is deliberate — vitest cannot import `server-only` modules, so the testable half must stay free of env and DB imports.

## Environment

`getServerEnv()` (`lib/server-env.ts`) **throws at first call** on any mismatch — chain ID, address shape, private-key format, `REQUIRED_PAYMENT_AMOUNT` not exactly `0.1`, or `APP_ENV` / `NEXT_PUBLIC_APP_ENV` disagreeing. A bad value fails the whole app rather than degrading.

`REQUIRED_PAYMENT_AMOUNT` governs only the **advertised price of the `human` mode**, and is checked against `HUMAN_ENTRY_FEE` in `lib/arcade-arenas.ts`. There is deliberately no per-arena env variable: one per arena would reintroduce exactly the duplication that let AGENT move from id 1 to 3 without anything noticing. The amount actually charged is revalidated against the on-chain fee in `verifyPayment`.

`.env.example` documents `NEXT_PUBLIC_ARCADE_VAULT_V6_ADDRESS` / `ARCADE_VAULT_V6_ADDRESS` and `NEXT_PUBLIC_VYNAR_REWARDS_V3_ADDRESS`. **This file has lied three times about the distributor name** — it documented `NEXT_PUBLIC_VYNAR_DISTRIBUTOR_ADDRESS`, then `..._REWARDS_V2_ADDRESS`, and each mismatch silently disabled all VYR rewards without an error. The rule that follows: if a name in `.env.example` does not match a `process.env` read in `lib/`, believe the code and fix this file. A good audit is `grep -o 'process\.env\.[A-Z_0-9]*' -r lib` against `grep -o '^[A-Z_0-9]*=' .env.example`.

`NEXT_PUBLIC_STAKING_VAULT_ADDRESS` / `STAKING_VAULT_ADDRESS` are documented but **nothing reads them yet** — the ABI exists from phase 0 and the app that consumes it is Etapa 6. Leaving them empty breaks nothing.

Two different variables select epoch duration and must be kept in sync: `APP_ENV` (server, `lib/server-env.ts:9`) and `NEXT_PUBLIC_APP_ENV` (client, `lib/arcade-config.ts:6`). Setting one does nothing for the other, and `getServerEnv()` now throws if they disagree — so **both** must be set.

`WALLET_AUTH_SECRET` is required (≥32 chars, e.g. `openssl rand -base64 48`). Without it every wallet-scoped endpoint returns 401 and the app is non-functional for signed-in features.

`server-only` is imported by 11 modules and is now a real dependency in `package.json`. Practical consequence is unchanged: **vitest still cannot import any `server-only` module.** Keep new logic in a pure module with no `server-only`, env, or DB import, or it will be untestable.

## Conventions

- **Code style is extremely dense.** `app/api/**` and `lib/**` pack many statements per line (`const a = x; const b = y; if (z) { ... }`). Match it; do not reformat.
- Errors: always `apiError(code, message, status, requestId)` from `lib/arcade-types.ts` with a fresh `crypto.randomUUID()`. Never leak internals in a message.
- Rate limiting is **Postgres-backed** (`consume_arcade_rate_limit`), not in-memory, so it survives restarts. It is a true sliding-window log (`arcade_rate_limit_hits`), and a rejected request neither extends the window nor burns quota. Every mutating route calls `consumeLimit`.
- Concurrency relies on optimistic CAS via `.eq('status', from)` in `lib/session-store.ts:transitionSession`. Preserve the expected-state filter when editing it.
- `lib/trusted-client-ip.ts` deliberately ignores `x-forwarded-for` (attacker-controlled). Keep it that way. Its fallbacks are `x-real-ip` → `x-vercel-forwarded-for` → `cf-connecting-ip`, and the last resort is the honest constant `'shared-edge-bucket'` — a per-request pseudo-identity would defeat the limiter entirely.
- `numeric(78,0)` columns must be read through the `*_wei` views (`svp_reward_allocations_wei`, `vyr_claims_wei`, `vyr_chain_snapshots_wei`), which cast to text. PostgREST otherwise emits a JSON *number* and silently rounds anything above 2^53. Do not query the base tables directly for amounts.
- Client-visible strings are mixed Spanish/English; `app/api/play/finish` responses are Spanish.

## Score ranking is derived in SQL, not app code

Ranking is intentionally **not** enforced by a unique constraint on `arcade_scores`. A wallet may legitimately buy several sessions per epoch, and a unique index on `(epoch, arena_type, wallet)` would reject the *improved* score. Instead:

- `arcade_scores_ranked` — recorded scores with `row_number()` per `(epoch, arena_type, lower(wallet))`, ties broken by earliest submission.
- `arcade_scores_best` — `wallet_rank = 1`, i.e. exactly one row per wallet per epoch per arena. **Use this for any ranking, reward or leaderboard read.**
- `arcade_leaderboard_public` — the narrow `anon`-readable projection (no `gameplay`, no `session_id`).

`arcade_scores_ranked` filters `status = 'recorded'` internally and that filter **must not be removed**. The views omit `security_invoker` so `anon` can read them without a grant on the base table — see the coupling warning in `20261001000200` about `force row level security`.

## Audit pass: what was fixed, and what is still open

A full audit produced 3 critical, 7 high and 12 medium findings. All of them are remediated; the audit migrations are `20261001000000` … `20261001000400`, and `tests/arcade.test.ts` pins the behavioural fixes. The previously-listed defects — unauthenticated wallet endpoints, forgeable scores, the missing `arcade_sessions.mint_tx_hash` column, duplicate leaderboard slots, the `gameplay`-exposing RLS policy, report-only CSP, the 30s/300s entry-gate mismatch, the never-purged rate-limit table — are all fixed. The V6 work added `20261002000000_arcade_v6_arenas.sql` and `20261002000100_payment_arena.sql`, and Etapa 6 added `20261003000000_boosters.sql`; 20 migrations apply in order and 68 schema checks pass.

Still open, and not to be mistaken for regressions:

- **Anti-cheat is not cryptographic.** `gameSeed` reaches the client, so a determined attacker can compute valid targets. `MIN_EVENT_INTERVAL_MS` and the seed-derived targets raise the cost of the trivial exploit (60 events at `atMs: 0`) but cannot eliminate it. `MIN_EVENT_INTERVAL_MS = 60` is the `human` value; each arena carries its own. Since Etapa 5 there is also **miss omission**: the score penalty for a miss only binds a client that declares the miss, so an attacker maximizes by not declaring misses — the same freedom it already had over which clicks to declare. Nothing is enforced here beyond `claimedScore !== expected`, which stops a *declared* miss from being paid as a hit, and `shieldValidationError`, which stops a miss being retroactively covered by a shield popped after it.
- **The SQL migrations have never been applied to a live database.** They are verified only by PGlite. Apply with `supabase db push` / `supabase db reset`.
- **The contracts have never been executed in an EVM.** V6/V3/StakingVault were written and reviewed outside the repo; `BoosterVault.sol` was written here. `compile:contracts` proves the source is valid Solidity for 0.8.24 with the right EVM version and optimizer, which is strictly less than "it works": no invariant has run, nothing has been fuzzed, nothing has been deployed. There is no Foundry in this environment, so **contract tests are still owed before real money moves.**
- **`BoosterVault.sol` has never been reviewed for the numbers in it.** `UNIT_PRICE_VYNAR = 25e18`, `STAKING_BPS = 7000` / `TREASURY_BPS = 3000` and the three delays are **policy proposals, not agreed values** — they were chosen to be internally coherent (the split sums to `BASIS`, `refundPurchase` can only reach unsettled money) but nobody set the price or the 70/30. Change them before deploying, not after.
- `supabase/schema-complete.sql` is a **consolidated from-scratch provisioning script** (`psql "$DATABASE_URL" -f supabase/schema-complete.sql`), not the source of truth. It has not been regenerated since the V6 migrations, so it is now **three migrations behind** and has neither `vynar_points` nor `arcade_booster_units`. **If it ever disagrees with `supabase/migrations/`, the migrations win** — regenerate the file rather than trusting it.
- `vyr_claims.points` has no authoritative in-repo source, so it is no longer client-settable; it is preserved if a row exists and written as `0` on first insert. `amount` is derived from chain `getEpochInfo`/`getPercentages`.
- SIWE-style auth cannot be E2E-tested offline. It needs a real wallet, `WALLET_AUTH_SECRET`, and a live Supabase to exercise `consume_arcade_auth_challenge`.

Dead code, safe to ignore: `lib/vyr-merkle.ts`, `lib/vynar-rewards-cron.ts`, `publicChainClient()` in `lib/server-blockchain.ts`, `components/ui/button.tsx` (well-built, imported nowhere), `app/api/incentive/proof` (410 compatibility stub), `lib/arcade-vault-v5-abi.ts` and `lib/arcade-vault-abi.ts` (superseded ABIs, imported by nothing but kept as the record of why AGENT moved from id 1 to 3), `vynarRewardsV2Abi` in `lib/vynar-config.ts`.
