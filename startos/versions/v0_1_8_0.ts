import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const v_0_1_8_0 = VersionInfo.of({
  version: '0.1.8:0',
  releaseNotes: {
    en_US:
      'Leftovers below the exchange minimum order are no longer converted, which stops pointless tiny rotations after a reserve top-up. Tested with real minimum order sizes so the reserve never loops between XMR and BTC.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
