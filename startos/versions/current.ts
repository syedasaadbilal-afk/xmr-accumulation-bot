import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const current = VersionInfo.of({
  version: '0.1.9:0',
  releaseNotes: {
    en_US:
      'A transfer in or out of the account while a rotation is running is now logged as a deposit or withdrawal instead of being absorbed into the new baseline. Leftovers below the exchange minimum order are no longer converted. Status has a reset to 0 link that restarts the since-start percentage from now, and the Timeline tab has a form to record a transfer the bot missed. The XAUT dust line on Status only shows from 0.0001 XAUT.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
