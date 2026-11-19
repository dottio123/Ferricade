import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fetchAllTags } from './tags'

const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('fetchAllTags', () => {
  it('follows next_cursor until exhausted and returns all tags', async () => {
    const page1Tags = [
      { id: '1', name: 'alpha', color: 4280391411 },
      { id: '2', name: 'beta', color: 4280391412 },
    ]
    const page2Tags = [{ id: '3', name: 'gamma', color: 4280391413 }]

    server.use(
      http.get('/admin/api/v1/tags', ({ request }) => {
        const url = new URL(request.url)
        const cursor = url.searchParams.get('cursor')
        expect(url.searchParams.get('limit')).toBe('200')

        if (!cursor) {
          return HttpResponse.json({
            items: page1Tags,
            next_cursor: 'cursor-2',
          })
        }
        if (cursor === 'cursor-2') {
          return HttpResponse.json({
            items: page2Tags,
            next_cursor: '',
          })
        }
        return HttpResponse.json(
          { error: { code: 'not_found', message: 'invalid cursor' } },
          { status: 404 },
        )
      }),
    )

    const all = await fetchAllTags()
    expect(all).toHaveLength(3)
    expect(all.map((t) => t.name)).toEqual(['alpha', 'beta', 'gamma'])
  })
})
