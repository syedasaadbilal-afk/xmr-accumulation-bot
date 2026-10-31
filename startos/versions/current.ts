import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const current = VersionInfo.of({
  version: '0.1.4:0',
  releaseNotes: {
    en_US:
      'PAUSED / DRY RUN now stops a rotation that is already running: the run mode is re-checked before every new order. The order in flight finishes (a sell is never left without its matching buy) and nothing further is placed.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
