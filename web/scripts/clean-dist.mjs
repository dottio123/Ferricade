// Removes stale build output but keeps dist/.gitkeep (the Go embed needs the
// directory to exist before the UI is built).
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

for (const name of ['index.html', 'assets']) {
  rmSync(fileURLToPath(new URL(`../dist/${name}`, import.meta.url)), {
    recursive: true,
    force: true,
  })
}
