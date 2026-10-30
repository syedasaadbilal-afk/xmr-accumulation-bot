import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const current = VersionInfo.of({
  version: '0.1.0:0',
  releaseNotes: {
    en_US:
      'First release. Mirrored Larsson Line on BTC priced in XMR (inverted XMR/BTC). Accumulates XMR, measured in XMR. Orders go through tXMRUST and tBTCUST, one limit order at a time, $2,000 default order size. Boots disabled in dry-run mode.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
