export const SVP_CHAIN_ID = 2517
export const SVP_EXPLORER_URL = 'https://explorer.svpchain.com'
export const ARCADE_ENTRY_FEE = '0.1'
export const PRODUCTION_EPOCH_DURATION = 86_400
export const TESTING_EPOCH_DURATION = 1_200
export const ARCADE_EPOCH_DURATION = process.env.NEXT_PUBLIC_APP_ENV === 'production' ? PRODUCTION_EPOCH_DURATION : TESTING_EPOCH_DURATION
export const ARCADE_ENTRY_CUTOFF_SECONDS = 300
export const ARCADE_ENTRY_FEE_WEI = BigInt('100000000000000000')
export const ARCADE_EPOCH_START = 1
