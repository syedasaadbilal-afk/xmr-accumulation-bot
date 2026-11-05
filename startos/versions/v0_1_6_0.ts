import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const v_0_1_6_0 = VersionInfo.of({
  version: '0.1.6:0',
  releaseNotes: {
    en_US:
      'The reserve is now held in BTC instead of XMR: a BTC reserve pot built from XMR when short, with the USDT reserve carved out of it by selling BTC. A last small gap is closed with the smallest XMR sale the exchange accepts. New Use it tick box switches the reserves off and on without losing the amounts.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
