import type { Abi } from 'viem'

// ABI generado con solc 0.8.30 (--optimize --optimize-runs 200).
// No editar a mano: regenerar desde el artefacto de compilacion.
// Destino del redeploy. Ver contracts/ARCADE-V6-NOTES.md antes de usarlo.
//
// MIGRACION CRITICA: el getter `arenas` devuelve 11 outputs en V6 frente a 9 en V5.
// Los indices 0-6 son identicos (entryFee, protocolFeeBps, epochDuration,
// currentEpoch, epochStart, epochEnd, pool). A partir de ahi se desplaza:
//   V5  pool(6) active(7) paused(8)
//   V6  pool(6) totalPaid(7) maxEntries(8) active(9) paused(10)
// Leer arena[7] esperando un bool devuelve un bigint en silencio. Para codigo
// nuevo conviene `getArenaInfo`, cuyos 10 outputs son estables y estan nombrados.
//
// Los ids numericos de arena NO se declaran aqui. Viven en lib/arcade-arenas.ts, que es el
// unico sitio donde se definen, y de ahi se importan. Este archivo antes declaraba su
// propia copia y `HUMAN_ARENA`/`HUMAN_ENTRY_FEE` vivian ademas en el ABI de V5: tres sitios
// con el mismo mapping es una bomba de reloj, y fue exactamente lo que ocurrio con AGENT
// al pasar de 1 a 3.

export type { ArenaId } from './arcade-arenas'

export const arcadeVaultV6Abi = [
  { type: 'function', name: 'arenas', stateMutability: 'view', inputs: [{ type: 'uint8' }], outputs: [{ name: 'entryFee', type: 'uint256' }, { name: 'protocolFeeBps', type: 'uint256' }, { name: 'epochDuration', type: 'uint256' }, { name: 'currentEpoch', type: 'uint256' }, { name: 'epochStart', type: 'uint256' }, { name: 'epochEnd', type: 'uint256' }, { name: 'pool', type: 'uint256' }, { name: 'totalPaid', type: 'uint256' }, { name: 'maxEntries', type: 'uint256' }, { name: 'active', type: 'bool' }, { name: 'paused', type: 'bool' }] },
  { type: 'function', name: 'BASIS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'CLAIM_DEADLINE', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'claimed', stateMutability: 'view', inputs: [{ type: 'uint8' }, { type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'claimPrize', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'epoch', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'claimPrizeTo', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'epoch', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [] },
  { type: 'function', name: 'closeEpoch', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }], outputs: [] },
  { type: 'function', name: 'eip712Domain', stateMutability: 'view', inputs: [], outputs: [{ name: 'fields', type: 'bytes1' }, { name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }, { name: 'salt', type: 'bytes32' }, { name: 'extensions', type: 'uint256[]' }] },
  { type: 'function', name: 'emergencyWithdraw', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'entries', stateMutability: 'view', inputs: [{ type: 'uint8' }, { type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'epochResults', stateMutability: 'view', inputs: [{ type: 'uint8' }, { type: 'uint256' }], outputs: [{ name: 'winnerCount', type: 'uint256' }, { name: 'prizePool', type: 'uint256' }, { name: 'totalPaid', type: 'uint256' }, { name: 'paidOut', type: 'uint256' }, { name: 'closedAt', type: 'uint256' }, { name: 'closed', type: 'bool' }, { name: 'voided', type: 'bool' }, { name: 'swept', type: 'bool' }] },
  { type: 'function', name: 'extendCurrentEpoch', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'extraSeconds', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'forceCloseEpoch', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }], outputs: [] },
  { type: 'function', name: 'fundPool', stateMutability: 'payable', inputs: [{ name: 'arena', type: 'uint8' }], outputs: [] },
  { type: 'function', name: 'gameServerSigner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getArenaInfo', stateMutability: 'view', inputs: [{ name: 'arena', type: 'uint8' }], outputs: [{ name: 'entryFee', type: 'uint256' }, { name: 'protocolFeeBps', type: 'uint256' }, { name: 'epochDuration', type: 'uint256' }, { name: 'currentEpoch', type: 'uint256' }, { name: 'epochStart', type: 'uint256' }, { name: 'epochEnd', type: 'uint256' }, { name: 'pool', type: 'uint256' }, { name: 'active', type: 'bool' }, { name: 'paused', type: 'bool' }, { name: 'secondsLeft', type: 'uint256' }] },
  { type: 'function', name: 'getArenaSnapshot', stateMutability: 'view', inputs: [{ name: 'arena', type: 'uint8' }], outputs: [{ name: 'maxEntries', type: 'uint256' }, { name: 'totalPaid', type: 'uint256' }, { name: 'myEntries', type: 'uint256' }, { name: 'protocolFeeWei', type: 'uint256' }, { name: 'prizePerEntryWei', type: 'uint256' }] },
  { type: 'function', name: 'getEpochDuration', stateMutability: 'view', inputs: [{ name: 'arena', type: 'uint8' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getEpochResult', stateMutability: 'view', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'epoch', type: 'uint256' }], outputs: [{ name: 'winners', type: 'address[3]' }, { name: 'bps', type: 'uint256[3]' }, { name: 'winnerCount', type: 'uint256' }, { name: 'prizePool', type: 'uint256' }, { name: 'paidOut', type: 'uint256' }, { name: 'totalPaid', type: 'uint256' }, { name: 'closed', type: 'bool' }, { name: 'voided', type: 'bool' }, { name: 'swept', type: 'bool' }] },
  { type: 'function', name: 'getPersonalBest', stateMutability: 'view', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'epoch', type: 'uint256' }, { name: 'player', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getTop10', stateMutability: 'view', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'epoch', type: 'uint256' }], outputs: [{ name: 'players', type: 'address[10]' }, { name: 'scores', type: 'uint256[10]' }] },
  { type: 'function', name: 'LATE_PAYMENT_BLOCK', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'leaderboard', stateMutability: 'view', inputs: [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }], outputs: [{ name: 'player', type: 'address' }, { name: 'score', type: 'uint256' }] },
  { type: 'function', name: 'MAX_EPOCH_DURATION', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'MAX_PROTOCOL_FEE_BPS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'MIN_EPOCH_DURATION', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'paidAmount', stateMutability: 'view', inputs: [{ type: 'uint8' }, { type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'paidPlayers', stateMutability: 'view', inputs: [{ type: 'uint8' }, { type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'payToPlay', stateMutability: 'payable', inputs: [{ name: 'arena', type: 'uint8' }], outputs: [] },
  { type: 'function', name: 'personalBest', stateMutability: 'view', inputs: [{ type: 'uint8' }, { type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'prizeLiability', stateMutability: 'view', inputs: [{ name: 'arena', type: 'uint8' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'recordScore', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'player', type: 'address' }, { name: 'score', type: 'uint256' }, { name: 'sessionId', type: 'bytes32' }, { name: 'epoch', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'signature', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'refund', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'epoch', type: 'uint256' }], outputs: [{ name: 'amount', type: 'uint256' }] },
  { type: 'function', name: 'renounceOwnership', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'setArenaActive', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'active', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'setArenaFee', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'fee', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setEpochDuration', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'duration', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setEpochDurationNow', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'duration', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setGameServerSigner', stateMutability: 'nonpayable', inputs: [{ name: 'signer', type: 'address' }], outputs: [] },
  { type: 'function', name: 'setMaxEntries', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'maxEntries', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setPaused', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: '_paused', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'setProtocolFee', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'feeBps', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setTreasury', stateMutability: 'nonpayable', inputs: [{ name: 'newTreasury', type: 'address' }], outputs: [] },
  { type: 'function', name: 'sweepUnclaimed', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'epoch', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'totalPrizeLiability', stateMutability: 'view', inputs: [{ type: 'uint8' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transferOwnership', stateMutability: 'nonpayable', inputs: [{ name: 'newOwner', type: 'address' }], outputs: [] },
  { type: 'function', name: 'treasury', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'usedNonces', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'usedSessionIds', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'event', name: 'ArenaActiveUpdated', anonymous: false, inputs: [{ name: 'arena', type: 'uint8', indexed: true }, { name: 'active', type: 'bool', indexed: false }] },
  { type: 'event', name: 'ArenaConfigUpdated', anonymous: false, inputs: [{ name: 'arena', type: 'uint8', indexed: true }] },
  { type: 'event', name: 'ArenaPaused', anonymous: false, inputs: [{ name: 'arena', type: 'uint8', indexed: true }, { name: 'paused', type: 'bool', indexed: false }] },
  { type: 'event', name: 'EIP712DomainChanged', anonymous: false, inputs: [] },
  { type: 'event', name: 'EmergencyWithdrawn', anonymous: false, inputs: [{ name: 'to', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'EpochClosed', anonymous: false, inputs: [{ name: 'arena', type: 'uint8', indexed: true }, { name: 'epoch', type: 'uint256', indexed: false }, { name: 'prizePool', type: 'uint256', indexed: false }, { name: 'winnerCount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'EpochDurationUpdated', anonymous: false, inputs: [{ name: 'arena', type: 'uint8', indexed: true }, { name: 'oldDuration', type: 'uint256', indexed: false }, { name: 'newDuration', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'EpochExtended', anonymous: false, inputs: [{ name: 'arena', type: 'uint8', indexed: true }, { name: 'newEpochEnd', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'EpochVoided', anonymous: false, inputs: [{ name: 'arena', type: 'uint8', indexed: true }, { name: 'epoch', type: 'uint256', indexed: false }, { name: 'refundablePool', type: 'uint256', indexed: false }, { name: 'forced', type: 'bool', indexed: false }] },
  { type: 'event', name: 'OwnershipTransferred', anonymous: false, inputs: [{ name: 'previousOwner', type: 'address', indexed: true }, { name: 'newOwner', type: 'address', indexed: true }] },
  { type: 'event', name: 'PaymentReceived', anonymous: false, inputs: [{ name: 'player', type: 'address', indexed: true }, { name: 'arena', type: 'uint8', indexed: true }, { name: 'epoch', type: 'uint256', indexed: false }, { name: 'amount', type: 'uint256', indexed: false }, { name: 'entryIndex', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'PersonalBestUpdated', anonymous: false, inputs: [{ name: 'player', type: 'address', indexed: true }, { name: 'arena', type: 'uint8', indexed: true }, { name: 'epoch', type: 'uint256', indexed: false }, { name: 'oldScore', type: 'uint256', indexed: false }, { name: 'newScore', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'PoolFunded', anonymous: false, inputs: [{ name: 'arena', type: 'uint8', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'PrizeClaimed', anonymous: false, inputs: [{ name: 'player', type: 'address', indexed: true }, { name: 'arena', type: 'uint8', indexed: true }, { name: 'epoch', type: 'uint256', indexed: false }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'PrizeClaimedTo', anonymous: false, inputs: [{ name: 'player', type: 'address', indexed: true }, { name: 'recipient', type: 'address', indexed: true }, { name: 'arena', type: 'uint8', indexed: true }, { name: 'epoch', type: 'uint256', indexed: false }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Refunded', anonymous: false, inputs: [{ name: 'player', type: 'address', indexed: true }, { name: 'arena', type: 'uint8', indexed: true }, { name: 'epoch', type: 'uint256', indexed: false }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'ScoreRecorded', anonymous: false, inputs: [{ name: 'player', type: 'address', indexed: true }, { name: 'arena', type: 'uint8', indexed: true }, { name: 'epoch', type: 'uint256', indexed: false }, { name: 'score', type: 'uint256', indexed: false }, { name: 'sessionId', type: 'bytes32', indexed: false }] },
  { type: 'event', name: 'SignerUpdated', anonymous: false, inputs: [{ name: 'signer', type: 'address', indexed: true }] },
  { type: 'event', name: 'TreasuryUpdated', anonymous: false, inputs: [{ name: 'treasury', type: 'address', indexed: true }] },
  { type: 'event', name: 'UnclaimedSwept', anonymous: false, inputs: [{ name: 'arena', type: 'uint8', indexed: true }, { name: 'epoch', type: 'uint256', indexed: false }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'error', name: 'ECDSAInvalidSignature', inputs: [] },
  { type: 'error', name: 'ECDSAInvalidSignatureLength', inputs: [{ name: 'length', type: 'uint256' }] },
  { type: 'error', name: 'ECDSAInvalidSignatureS', inputs: [{ name: 's', type: 'bytes32' }] },
  { type: 'error', name: 'InvalidShortString', inputs: [] },
  { type: 'error', name: 'OwnableInvalidOwner', inputs: [{ name: 'owner', type: 'address' }] },
  { type: 'error', name: 'OwnableUnauthorizedAccount', inputs: [{ name: 'account', type: 'address' }] },
  { type: 'error', name: 'ReentrancyGuardReentrantCall', inputs: [] },
  { type: 'error', name: 'StringTooLong', inputs: [{ name: 'str', type: 'string' }] },
] as const satisfies Abi

export type ArcadeVaultV6Abi = typeof arcadeVaultV6Abi
export const arcadeVaultV6Address = (process.env.NEXT_PUBLIC_ARCADE_VAULT_V6_ADDRESS ?? process.env.ARCADE_VAULT_V6_ADDRESS) as `0x${string}`
// El dominio NO cambia respecto a V5 a proposito: la app firma con el. Cambiarlo
// obliga a coordinar el redeploy del vault con el del backend.
export const V6_EIP712_DOMAIN = { name: 'VerityArcadeV5', version: '1' } as const
export const V6_SCORE_TYPES = { Score: [{ name: 'arena', type: 'uint8' }, { name: 'player', type: 'address' }, { name: 'score', type: 'uint256' }, { name: 'sessionId', type: 'bytes32' }, { name: 'epoch', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] } as const

// 50 funciones, 20 eventos, 8 errores.
