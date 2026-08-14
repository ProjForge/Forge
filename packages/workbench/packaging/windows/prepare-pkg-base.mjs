import { writeFile } from 'node:fs/promises'
import { need } from '@yao-pkg/pkg-fetch'

const output = process.argv[2]
if (!output) throw new Error('An output path is required')

const binary = await need({
  nodeRange: 'node22',
  platform: 'win',
  arch: 'x64'
})

await writeFile(output, binary, 'utf8')
