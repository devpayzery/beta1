export function derivePaymentEpoch(input: { currentEpoch: bigint; currentEpochStart: bigint; epochDuration: bigint; paymentTimestamp: bigint }): bigint {
  if (input.epochDuration <= BigInt(0)) throw new Error('INVALID_EPOCH_DURATION')
  if (input.paymentTimestamp < input.currentEpochStart) {
    const elapsedEpochs = (input.currentEpochStart - input.paymentTimestamp + input.epochDuration - BigInt(1)) / input.epochDuration
    return input.currentEpoch - elapsedEpochs
  }
  const elapsedEpochs = (input.paymentTimestamp - input.currentEpochStart) / input.epochDuration
  return input.currentEpoch + elapsedEpochs
}

export function isPaymentStateBlocking(state: 'IDLE' | 'PAYMENT_PENDING' | 'PAYMENT_CONFIRMED' | 'SESSION_CREATING' | 'READY_TO_PLAY' | 'PLAYING' | 'SUBMITTING' | 'RECOVERING' | 'ERROR_REQUIRES_ACTION') {
  return state !== 'IDLE' && state !== 'ERROR_REQUIRES_ACTION'
}
