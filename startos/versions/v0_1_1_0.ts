import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const v_0_1_1_0 = VersionInfo.of({
  version: '0.1.1:0',
  releaseNotes: {
    en_US:
      'Fix: load the full XMR/BTC daily history (back to 2016) so the Larsson lines match TradingView exactly. Previously only the last 1,000 bars were used, which gave a wrong 2024 entry/exit in the trade list. Candles are cached for 2 minutes.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
