import type { Abi } from 'viem'

// ABI generado con solc 0.8.30 (--optimize --optimize-runs 200).
// No editar a mano: regenerar desde el artefacto de compilacion.
// Destino del redeploy. Ver contracts/ARCADE-V6-NOTES.md.

export const vynarRewardsV3Abi = [
  { type: 'function', name: 'arenaReserved', stateMutability: 'view', inputs: [{ name: 'arena', type: 'uint8' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'BASIS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'batchClaim', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'epochs', type: 'uint256[]' }], outputs: [] },
  { type: 'function', name: 'cancelEpoch', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'epoch', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'epoch', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'claimed', stateMutability: 'view', inputs: [{ type: 'uint8' }, { type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'claimTo', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'epoch', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [] },
  { type: 'function', name: 'eip712Domain', stateMutability: 'view', inputs: [], outputs: [{ name: 'fields', type: 'bytes1' }, { name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }, { name: 'salt', type: 'bytes32' }, { name: 'extensions', type: 'uint256[]' }] },
  { type: 'function', name: 'epochList', stateMutability: 'view', inputs: [{ type: 'uint8' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'epochRewards', stateMutability: 'view', inputs: [{ type: 'uint8' }, { type: 'uint256' }], outputs: [{ name: 'pool', type: 'uint256' }, { name: 'positionCount', type: 'uint256' }, { name: 'totalClaimed', type: 'uint256' }, { name: 'settledAt', type: 'uint256' }, { name: 'funded', type: 'bool' }, { name: 'settled', type: 'bool' }, { name: 'canceled', type: 'bool' }] },
  { type: 'function', name: 'getEpochInfo', stateMutability: 'view', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'epoch', type: 'uint256' }], outputs: [{ name: 'pool', type: 'uint256' }, { name: 'positionCount', type: 'uint256' }, { name: 'winners', type: 'address[]' }, { name: 'totalClaimed', type: 'uint256' }, { name: 'settledAt', type: 'uint256' }, { name: 'funded', type: 'bool' }, { name: 'settled', type: 'bool' }, { name: 'canceled', type: 'bool' }] },
  { type: 'function', name: 'getEpochs', stateMutability: 'view', inputs: [{ name: 'arena', type: 'uint8' }], outputs: [{ type: 'uint256[]' }] },
  { type: 'function', name: 'getPercentages', stateMutability: 'view', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'epoch', type: 'uint256' }], outputs: [{ type: 'uint256[]' }] },
  { type: 'function', name: 'getWinners', stateMutability: 'view', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'epoch', type: 'uint256' }], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'latestSettledAt', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'MAX_WINNERS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'openEpoch', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'epoch', type: 'uint256' }, { name: 'pool', type: 'uint256' }, { name: 'percentages', type: 'uint256[]' }], outputs: [] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'publisher', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'registeredArenas', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8[]' }] },
  { type: 'function', name: 'renounceOwnership', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'reservedBalance', stateMutability: 'view', inputs: [{ type: 'uint8' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'setPublisher', stateMutability: 'nonpayable', inputs: [{ name: '_publisher', type: 'address' }], outputs: [] },
  { type: 'function', name: 'setSigner', stateMutability: 'nonpayable', inputs: [{ name: '_signer', type: 'address' }], outputs: [] },
  { type: 'function', name: 'signer', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'submitWinners', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'epoch', type: 'uint256' }, { name: 'winners', type: 'address[]' }], outputs: [] },
  { type: 'function', name: 'submitWinnersWithSignature', stateMutability: 'nonpayable', inputs: [{ name: 'arena', type: 'uint8' }, { name: 'epoch', type: 'uint256' }, { name: 'winners', type: 'address[]' }, { name: 'deadline', type: 'uint256' }, { name: 'signature', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'totalReserved', stateMutability: 'view', inputs: [], outputs: [{ name: 'total', type: 'uint256' }] },
  { type: 'function', name: 'transferOwnership', stateMutability: 'nonpayable', inputs: [{ name: 'newOwner', type: 'address' }], outputs: [] },
  { type: 'function', name: 'vynarToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'WINNERS_TYPEHASH', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'WITHDRAW_DELAY', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'event', name: 'ArenaRegistered', anonymous: false, inputs: [{ name: 'arena', type: 'uint8', indexed: true }] },
  { type: 'event', name: 'EIP712DomainChanged', anonymous: false, inputs: [] },
  { type: 'event', name: 'EpochCanceled', anonymous: false, inputs: [{ name: 'arena', type: 'uint8', indexed: true }, { name: 'epoch', type: 'uint256', indexed: true }, { name: 'refunded', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'EpochOpened', anonymous: false, inputs: [{ name: 'arena', type: 'uint8', indexed: true }, { name: 'epoch', type: 'uint256', indexed: true }, { name: 'pool', type: 'uint256', indexed: false }, { name: 'positionCount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'OwnershipTransferred', anonymous: false, inputs: [{ name: 'previousOwner', type: 'address', indexed: true }, { name: 'newOwner', type: 'address', indexed: true }] },
  { type: 'event', name: 'PublisherUpdated', anonymous: false, inputs: [{ name: 'publisher', type: 'address', indexed: true }] },
  { type: 'event', name: 'RewardClaimed', anonymous: false, inputs: [{ name: 'arena', type: 'uint8', indexed: true }, { name: 'epoch', type: 'uint256', indexed: true }, { name: 'player', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'RewardClaimedTo', anonymous: false, inputs: [{ name: 'arena', type: 'uint8', indexed: true }, { name: 'epoch', type: 'uint256', indexed: true }, { name: 'recipient', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'SignerUpdated', anonymous: false, inputs: [{ name: 'signer', type: 'address', indexed: true }] },
  { type: 'event', name: 'WinnersSubmitted', anonymous: false, inputs: [{ name: 'arena', type: 'uint8', indexed: true }, { name: 'epoch', type: 'uint256', indexed: true }, { name: 'winners', type: 'address[]', indexed: false }] },
  { type: 'event', name: 'Withdrawn', anonymous: false, inputs: [{ name: 'to', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'error', name: 'ECDSAInvalidSignature', inputs: [] },
  { type: 'error', name: 'ECDSAInvalidSignatureLength', inputs: [{ name: 'length', type: 'uint256' }] },
  { type: 'error', name: 'ECDSAInvalidSignatureS', inputs: [{ name: 's', type: 'bytes32' }] },
  { type: 'error', name: 'InvalidShortString', inputs: [] },
  { type: 'error', name: 'OwnableInvalidOwner', inputs: [{ name: 'owner', type: 'address' }] },
  { type: 'error', name: 'OwnableUnauthorizedAccount', inputs: [{ name: 'account', type: 'address' }] },
  { type: 'error', name: 'ReentrancyGuardReentrantCall', inputs: [] },
  { type: 'error', name: 'SafeERC20FailedOperation', inputs: [{ name: 'token', type: 'address' }] },
  { type: 'error', name: 'StringTooLong', inputs: [{ name: 'str', type: 'string' }] },
] as const satisfies Abi

export type VynarRewardsV3Abi = typeof vynarRewardsV3Abi
export const vynarRewardsV3Address = (process.env.NEXT_PUBLIC_VYNAR_REWARDS_V3_ADDRESS ?? process.env.VYNAR_REWARDS_V3_ADDRESS) as `0x${string}`
// El dominio NO cambia respecto a V2 a proposito: la app firma con el.
export const V3_EIP712_DOMAIN = { name: 'VynarRewardsV2', version: '1' } as const
export const V3_WINNERS_TYPES = { Winners: [{ name: 'arena', type: 'uint8' }, { name: 'epoch', type: 'uint256' }, { name: 'winners', type: 'address[]' }, { name: 'deadline', type: 'uint256' }] } as const

// 33 funciones, 11 eventos, 9 errores.
