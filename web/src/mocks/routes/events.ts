// GET /admin/api/v1/events: `retry: 3000`, then one message per change of the
// mock DB, written as `event: <type>` and `data: <LiveEvent JSON>` exactly as the
// real stream is. Two MSW handlers serve the one operation: a plain GET handler
// first applies delay, ?mock-fail and the session gate (401, 403, 500), and
// otherwise lets the request through to the stream handler, which only answers
// `Accept: text/event-stream`.
//
// The stream is a plain ReadableStream rather than MSW's sse(): sse() is not
// told when the page closes its EventSource (in the browser), so it kept
// writing to the dead stream and logged an error for every later change.
// Here the stream's cancel() unsubscribes.
import { delay, http, HttpResponse, type HttpHandler } from 'msw'
import type { LiveEvent } from '../fixtures/types'
import { authorize, errorResponse, operationId, type Env } from '../route'

const PATH = '/admin/api/v1/events'

export function eventsRoutes(env: Env): HttpHandler[] {
  const id = operationId('get', PATH)

  const gate = http.get(PATH, async ({ request }) => {
    if (env.config.delayMs > 0) await delay(env.config.delayMs)
    // A server that is not back yet (controls.dropEventStreams): the request waits.
    const hold = env.streams.holdUntil - env.db.now()
    if (hold > 0) await delay(hold)
    if (env.config.failOperations.has(id)) {
      return errorResponse(500, 'internal', `mock-fail: ${id}`, 'mock-request-id')
    }
    const result = authorize(env, 'mfa', request)
    return result instanceof Response ? result : undefined
  })

  const stream = http.get(PATH, ({ request }) => {
    if (request.headers.get('Accept') !== 'text/event-stream') return undefined
    const encoder = new TextEncoder()
    // A User's stream: only what they may see, and `resync` when what they may see changes.
    const viewer = env.session.userId ? env.db.findUser(env.session.userId) : undefined
    const scope = viewer?.role === 'user' ? viewer.id : null
    let visible = scope ? env.db.visibleDeviceIds(scope) : new Set<string>()
    let stop = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true
        const close = () => {
          stop()
          try {
            controller.close()
          } catch {
            // already closed or cancelled
          }
        }
        const write = (text: string) => {
          if (!open) return
          try {
            controller.enqueue(encoder.encode(text))
          } catch {
            stop() // the reader went away without cancelling
          }
        }
        const send = (event: LiveEvent) =>
          write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        const unsubscribe = env.db.subscribe((event) => {
          if (!scope) return send(event)
          // Every change (a device moved, approved, deleted, grants replaced) arrives as an
          // event, so the visible set is compared first, as the server does after its debounce.
          const next = env.db.visibleDeviceIds(scope)
          const changed = next.size !== visible.size || [...next].some((id) => !visible.has(id))
          visible = next
          if (changed) {
            send({ type: 'resync' })
            return close()
          }
          if (userMayReceive(env, scope, visible, event)) send(event)
        })
        stop = () => {
          if (!open) return
          open = false
          unsubscribe()
          env.streams.closers.delete(close)
        }
        env.streams.closers.add(close)
        write('retry: 3000\n\n')
      },
      cancel() {
        stop()
      },
    })
    request.signal.addEventListener('abort', () => stop(), { once: true })
    return new HttpResponse(body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    })
  })

  return [gate, stream]
}

/** The server's filter for a User's stream (events.go): visible devices, own audit entries. */
function userMayReceive(
  env: Env,
  userId: string,
  visible: ReadonlySet<string>,
  event: LiveEvent,
): boolean {
  switch (event.type) {
    case 'device.enrolled':
      return false
    case 'audit.created':
      return env.db.auditLog.find((e) => e.id === event.audit_id)?.actor_user_id === userId
    case 'preferences.updated':
      return event.user_id === userId
    case 'resync':
      return true
    default:
      return event.device_id !== undefined && visible.has(event.device_id)
  }
}
