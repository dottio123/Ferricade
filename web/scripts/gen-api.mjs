// Generates src/api/schema.d.ts from the API contract (internal/adminapi/openapi.yaml).
//   node scripts/gen-api.mjs          write the file
//   node scripts/gen-api.mjs --check  exit 1 when the committed file is stale (CI)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import openapiTS, { astToString } from 'openapi-typescript'

const spec = new URL('../../internal/adminapi/openapi.yaml', import.meta.url)
const out = new URL('../src/api/schema.d.ts', import.meta.url)

const header = `/**
 * GENERATED FILE. DO NOT EDIT BY HAND.
 * Source: internal/adminapi/openapi.yaml (the API contract).
 * Regenerate with \`npm run gen:api\`; \`npm run gen:api:check\` fails when this file is stale.
 */

`

const generated = header + astToString(await openapiTS(spec))

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(out, 'utf8')
  } catch {
    // a missing file is stale too
  }
  // git stores LF (.gitattributes); a CRLF working copy is not a stale schema.
  if (current.replace(/\r\n/g, '\n') !== generated) {
    console.error('src/api/schema.d.ts is stale: run `npm run gen:api` and commit the result.')
    process.exit(1)
  }
  console.log('gen:api:check ok')
} else {
  mkdirSync(new URL('.', out), { recursive: true })
  writeFileSync(out, generated)
  console.log('wrote src/api/schema.d.ts')
}
