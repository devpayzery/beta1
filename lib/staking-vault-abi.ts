import type { Abi } from 'viem'

// ABI generado con solc 0.8.30 (--optimize --optimize-runs 200).
// No editar a mano: regenerar desde el artefacto de compilacion.
// Ver contracts/StakingVault.sol para la semántica de accrue.

export enum StakingPool {
  SVP = 0,
  VYNAR = 1,
}

// BigInt via constructor, no literales 86400n: el target de tsconfig es anterior
// a ES2020 y los literales bigint no compilan. Es la convencion de lib/.
export const STAKING_DAY = BigInt(86400)
export const STAKING_WITHDRAW_LOCK = BigInt(86400)
export const STAKING_PRICE_SCALE = BigInt('1000000000000000000')

export const stakingVaultAbi = [
  { type: 'function', name: 'BASIS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [{ name: 'pool', type: 'uint8' }], outputs: [] },
  { type: 'function', name: 'claimableAt', stateMutability: 'view', inputs: [{ name: 'pool', type: 'uint8' }, { name: 'user', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'claimAndUnstake', stateMutability: 'nonpayable', inputs: [{ name: 'pool', type: 'uint8' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'dailyBudget', stateMutability: 'view', inputs: [{ name: 'pool', type: 'uint8' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'dailyRateBps', stateMutability: 'view', inputs: [{ type: 'uint8' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'DAY', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'fundingSplit', stateMutability: 'view', inputs: [{ name: 'pool', type: 'uint8' }], outputs: [{ name: 'feesBps', type: 'uint256' }, { name: 'mintBps', type: 'uint256' }] },
  { type: 'function', name: 'MAX_DAILY_RATE_BPS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'minter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'notifyRewardSvp', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'notifyRewardVynar', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'pendingOf', stateMutability: 'view', inputs: [{ name: 'pool', type: 'uint8' }, { name: 'user', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'poke', stateMutability: 'nonpayable', inputs: [{ name: 'pool', type: 'uint8' }], outputs: [] },
  { type: 'function', name: 'pools', stateMutability: 'view', inputs: [{ type: 'uint8' }], outputs: [{ name: 'stakedTotal', type: 'uint256' }, { name: 'accPricePerShare', type: 'uint256' }, { name: 'lastClosedDay', type: 'uint256' }, { name: 'rewardReserve', type: 'uint256' }, { name: 'undistributed', type: 'uint256' }, { name: 'totalReleased', type: 'uint256' }, { name: 'totalClaimed', type: 'uint256' }, { name: 'fundedFromFees', type: 'uint256' }, { name: 'fundedFromMint', type: 'uint256' }, { name: 'paused', type: 'bool' }] },
  { type: 'function', name: 'PRICE_SCALE', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'renounceOwnership', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'rescue', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'rescueVynar', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setDailyRate', stateMutability: 'nonpayable', inputs: [{ name: 'pool', type: 'uint8' }, { name: 'bps', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setMinter', stateMutability: 'nonpayable', inputs: [{ name: 'newMinter', type: 'address' }], outputs: [] },
  { type: 'function', name: 'setPaused', stateMutability: 'nonpayable', inputs: [{ name: 'pool', type: 'uint8' }, { name: 'paused', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'solvency', stateMutability: 'view', inputs: [{ name: 'pool', type: 'uint8' }], outputs: [{ type: 'int256' }] },
  { type: 'function', name: 'stakeSvp', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'stakeVynar', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'topUpFromMint', stateMutability: 'nonpayable', inputs: [{ name: 'pool', type: 'uint8' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'transferOwnership', stateMutability: 'nonpayable', inputs: [{ name: 'newOwner', type: 'address' }], outputs: [] },
  { type: 'function', name: 'unstake', stateMutability: 'nonpayable', inputs: [{ name: 'pool', type: 'uint8' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'users', stateMutability: 'view', inputs: [{ type: 'uint8' }, { type: 'address' }], outputs: [{ name: 'staked', type: 'uint256' }, { name: 'debtPrice', type: 'uint256' }, { name: 'pending', type: 'uint256' }, { name: 'lastActionAt', type: 'uint64' }] },
  { type: 'function', name: 'vynar', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'WITHDRAW_LOCK', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'event', name: 'Claimed', anonymous: false, inputs: [{ name: 'pool', type: 'uint8', indexed: true }, { name: 'user', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'DailyRateUpdated', anonymous: false, inputs: [{ name: 'pool', type: 'uint8', indexed: true }, { name: 'oldBps', type: 'uint256', indexed: false }, { name: 'newBps', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'DaysClosed', anonymous: false, inputs: [{ name: 'pool', type: 'uint8', indexed: true }, { name: 'dayCount', type: 'uint256', indexed: false }, { name: 'released', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'ExcessRescued', anonymous: false, inputs: [{ name: 'to', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'MinterUpdated', anonymous: false, inputs: [{ name: 'minter', type: 'address', indexed: true }] },
  { type: 'event', name: 'OwnershipTransferred', anonymous: false, inputs: [{ name: 'previousOwner', type: 'address', indexed: true }, { name: 'newOwner', type: 'address', indexed: true }] },
  { type: 'event', name: 'PoolPaused', anonymous: false, inputs: [{ name: 'pool', type: 'uint8', indexed: true }, { name: 'paused', type: 'bool', indexed: false }] },
  { type: 'event', name: 'RewardNotified', anonymous: false, inputs: [{ name: 'pool', type: 'uint8', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }, { name: 'fromMint', type: 'bool', indexed: false }] },
  { type: 'event', name: 'Staked', anonymous: false, inputs: [{ name: 'pool', type: 'uint8', indexed: true }, { name: 'user', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Unstaked', anonymous: false, inputs: [{ name: 'pool', type: 'uint8', indexed: true }, { name: 'user', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'error', name: 'OwnableInvalidOwner', inputs: [{ name: 'owner', type: 'address' }] },
  { type: 'error', name: 'OwnableUnauthorizedAccount', inputs: [{ name: 'account', type: 'address' }] },
  { type: 'error', name: 'ReentrancyGuardReentrantCall', inputs: [] },
  { type: 'error', name: 'SafeERC20FailedOperation', inputs: [{ name: 'token', type: 'address' }] },
] as const satisfies Abi

export type StakingVaultAbi = typeof stakingVaultAbi
export const stakingVaultAddress = (process.env.NEXT_PUBLIC_STAKING_VAULT_ADDRESS ?? process.env.STAKING_VAULT_ADDRESS) as `0x${string}`

// 32 funciones, 10 eventos, 4 errores.
