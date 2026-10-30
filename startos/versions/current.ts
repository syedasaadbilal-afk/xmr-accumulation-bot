import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const current = VersionInfo.of({
  version: '0.1.2:0',
  releaseNotes: {
    en_US:
      'Idle USDT sitting in the wallet is now swept into whatever the strategy wants (respecting the position cap). Timeline and Status now show cumulative return and CAGR for the chart signals.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
