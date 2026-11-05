import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const current = VersionInfo.of({
  version: '0.1.7:0',
  releaseNotes: {
    en_US:
      'The second reserve is now XAUT instead of USDT: part of the BTC reserve can be held as XAUT (bought with BTC through USDT, one order at a time) and is converted back to BTC when lowered or when the Use it tick box is switched off. Status shows the XAUT held.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
