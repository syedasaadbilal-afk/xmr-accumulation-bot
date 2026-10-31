import { VersionGraph } from '@start9labs/start-sdk'
import { current } from './current'
import { v_0_1_0_0 } from './v0_1_0_0'
import { v_0_1_1_0 } from './v0_1_1_0'
import { v_0_1_2_0 } from './v0_1_2_0'
import { v_0_1_3_0 } from './v0_1_3_0'
import { v_0_1_4_0 } from './v0_1_4_0'

export const versionGraph = VersionGraph.of({
  current,
  other: [v_0_1_0_0, v_0_1_1_0, v_0_1_2_0, v_0_1_3_0, v_0_1_4_0],
})
