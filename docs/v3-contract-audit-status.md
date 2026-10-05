# ArcadeVaultV3 audit status

- Deployed address: `0xFaDeA32c0Fa4a144999e16EAaa6697F93945AA5c`
- Network: SVP Chain testnet
- Chain ID: `2517`
- Human arena: `0`
- ABI: available locally in `lib/arcade-vault-v3-abi.ts`
- Solidity source: not available locally for ArcadeVaultV3. The repository's `contracts/` directory contains the legacy V2 source, not the deployed V3 source.
- Bytecode verification: not independently verified from this repository.

## Audit limitation

This repository cannot certify the deployed V3 implementation from the ABI alone. In particular, the local audit cannot prove V3 reentrancy protection, access control, prize accounting, epoch snapshot semantics, tie handling, or event/indexing behavior without the verified Solidity source or verified bytecode metadata.

No V3 source is fabricated from the ABI. This remediation sprint does not modify Solidity, ABI, selectors, deployment, or contract configuration.

## Gameplay integrity limitation

Score validation checks the shape, timing, bounds, and formula of client-submitted events. It does not provide cryptographically verifiable anti-cheat: the client still declares the event stream. A future anti-cheat design should evaluate deterministic replay, server-side execution, or another verifiable gameplay proof before claiming stronger guarantees.
