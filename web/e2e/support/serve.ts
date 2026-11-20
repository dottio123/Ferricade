// Playwright's webServer: serves dist-mock with ferricade's headers on PORT.
//   node e2e/support/serve.ts
import { serveDist } from './server.ts'

const port = Number(process.env.PORT ?? 4173)
const server = await serveDist({ port })
console.log(`serving dist-mock at ${server.url}`)
