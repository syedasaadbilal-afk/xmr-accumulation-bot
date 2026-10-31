import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const current = VersionInfo.of({
  version: '0.1.5:0',
  releaseNotes: {
    en_US:
      'Trades and Executions now also show the exchange pair price (BTC per XMR, as Bitfinex quotes it) next to the inverted price the strategy uses.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
