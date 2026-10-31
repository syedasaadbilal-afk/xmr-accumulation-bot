import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const v_0_1_3_0 = VersionInfo.of({
  version: '0.1.3:0',
  releaseNotes: {
    en_US:
      'Fix: a leftover of USDT too small to buy anything (below the minimum order of the pair, e.g. 0.02 XMR) no longer blocks the next rotation. It is set aside until the balance changes, so BTC/asset rotations always proceed.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
