import { getAddress, isAddress, type Address } from 'viem'
import type { Abi } from 'viem'

// ABI generado con solc 0.8.30 (--optimize --optimize-runs 200).
// No editar a mano: regenerar desde el artefacto de compilacion.

function configuredAddress(name: 'NEXT_PUBLIC_VYNAR_ADDRESS' | 'NEXT_PUBLIC_VYNAR_REWARDS_V3_ADDRESS'): Address | undefined {
  const value = process.env[name]?.trim()
  return value && isAddress(value) ? getAddress(value) : undefined
}

const configuredChainId = Number(process.env.NEXT_PUBLIC_VYNAR_CHAIN_ID ?? '2517')
if (!Number.isSafeInteger(configuredChainId) || configuredChainId <= 0) throw new Error('Invalid NEXT_PUBLIC_VYNAR_CHAIN_ID')

export const VYNAR_ADDRESS = configuredAddress('NEXT_PUBLIC_VYNAR_ADDRESS')
// VynarRewardsV3, no V2. V2 tiene withdraw() con las arenas 0 y 1 hardcodeadas, lo que lo
// invalida en cuanto existe una tercera arena; V3 itera las arenas registradas.
export const VYNAR_REWARDS_V3_ADDRESS = configuredAddress('NEXT_PUBLIC_VYNAR_REWARDS_V3_ADDRESS')
export const VYNAR_CHAIN_ID = configuredChainId

// EIP-3009 esta disponible en el token (transferWithAuthorization), que es lo que
// hace falta para cobrar boosters por HTTP 402 sin allowance previo.
export const vynarAbi = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'authorizationState', stateMutability: 'view', inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'batchAirdrop', stateMutability: 'nonpayable', inputs: [{ name: 'recipients', type: 'address[]' }, { name: 'amounts', type: 'uint256[]' }], outputs: [] },
  { type: 'function', name: 'burn', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'CANCEL_AUTHORIZATION_TYPEHASH', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'cancelAuthorization', stateMutability: 'nonpayable', inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }, { name: 'signature', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'eip712Domain', stateMutability: 'view', inputs: [], outputs: [{ name: 'fields', type: 'bytes1' }, { name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }, { name: 'salt', type: 'bytes32' }, { name: 'extensions', type: 'uint256[]' }] },
  { type: 'function', name: 'isMinter', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'mintForScore', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'points', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'mintForScoreOnce', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'points', type: 'uint256' }, { name: 'rewardId', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'permit', stateMutability: 'nonpayable', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'pointsPerToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'RECEIVE_WITH_AUTHORIZATION_TYPEHASH', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'receiveWithAuthorization', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }, { name: 'signature', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'renounceOwnership', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'scoreRewarded', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'setMinter', stateMutability: 'nonpayable', inputs: [{ name: 'minter', type: 'address' }, { name: 'allowed', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'setPointsPerToken', stateMutability: 'nonpayable', inputs: [{ name: 'newValue', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'TRANSFER_WITH_AUTHORIZATION_TYPEHASH', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'transferFrom', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'transferOwnership', stateMutability: 'nonpayable', inputs: [{ name: 'newOwner', type: 'address' }], outputs: [] },
  { type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }, { name: 'signature', type: 'bytes' }], outputs: [] },
  { type: 'event', name: 'Approval', anonymous: false, inputs: [{ name: 'owner', type: 'address', indexed: true }, { name: 'spender', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'AuthorizationCanceled', anonymous: false, inputs: [{ name: 'authorizer', type: 'address', indexed: true }, { name: 'nonce', type: 'bytes32', indexed: true }] },
  { type: 'event', name: 'AuthorizationUsed', anonymous: false, inputs: [{ name: 'authorizer', type: 'address', indexed: true }, { name: 'nonce', type: 'bytes32', indexed: true }] },
  { type: 'event', name: 'EIP712DomainChanged', anonymous: false, inputs: [] },
  { type: 'event', name: 'MinterUpdated', anonymous: false, inputs: [{ name: 'minter', type: 'address', indexed: true }, { name: 'allowed', type: 'bool', indexed: false }] },
  { type: 'event', name: 'OwnershipTransferred', anonymous: false, inputs: [{ name: 'previousOwner', type: 'address', indexed: true }, { name: 'newOwner', type: 'address', indexed: true }] },
  { type: 'event', name: 'PointsPerTokenUpdated', anonymous: false, inputs: [{ name: 'oldValue', type: 'uint256', indexed: false }, { name: 'newValue', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'ScoreRewardMinted', anonymous: false, inputs: [{ name: 'to', type: 'address', indexed: true }, { name: 'points', type: 'uint256', indexed: false }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'ScoreRewardMintedOnce', anonymous: false, inputs: [{ name: 'rewardId', type: 'bytes32', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'points', type: 'uint256', indexed: false }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Transfer', anonymous: false, inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] },
  { type: 'error', name: 'ECDSAInvalidSignature', inputs: [] },
  { type: 'error', name: 'ECDSAInvalidSignatureLength', inputs: [{ name: 'length', type: 'uint256' }] },
  { type: 'error', name: 'ECDSAInvalidSignatureS', inputs: [{ name: 's', type: 'bytes32' }] },
  { type: 'error', name: 'ERC20InsufficientAllowance', inputs: [{ name: 'spender', type: 'address' }, { name: 'allowance', type: 'uint256' }, { name: 'needed', type: 'uint256' }] },
  { type: 'error', name: 'ERC20InsufficientBalance', inputs: [{ name: 'sender', type: 'address' }, { name: 'balance', type: 'uint256' }, { name: 'needed', type: 'uint256' }] },
  { type: 'error', name: 'ERC20InvalidApprover', inputs: [{ name: 'approver', type: 'address' }] },
  { type: 'error', name: 'ERC20InvalidReceiver', inputs: [{ name: 'receiver', type: 'address' }] },
  { type: 'error', name: 'ERC20InvalidSender', inputs: [{ name: 'sender', type: 'address' }] },
  { type: 'error', name: 'ERC20InvalidSpender', inputs: [{ name: 'spender', type: 'address' }] },
  { type: 'error', name: 'ERC2612ExpiredSignature', inputs: [{ name: 'deadline', type: 'uint256' }] },
  { type: 'error', name: 'ERC2612InvalidSigner', inputs: [{ name: 'signer', type: 'address' }, { name: 'owner', type: 'address' }] },
  { type: 'error', name: 'InvalidAccountNonce', inputs: [{ name: 'account', type: 'address' }, { name: 'currentNonce', type: 'uint256' }] },
  { type: 'error', name: 'InvalidShortString', inputs: [] },
  { type: 'error', name: 'OwnableInvalidOwner', inputs: [{ name: 'owner', type: 'address' }] },
  { type: 'error', name: 'OwnableUnauthorizedAccount', inputs: [{ name: 'account', type: 'address' }] },
  { type: 'error', name: 'StringTooLong', inputs: [{ name: 'str', type: 'string' }] },
] as const satisfies Abi

// vynarAbi: 33 functions, 10 events, 16 errors.