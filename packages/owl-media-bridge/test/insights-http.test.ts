import { describe, expect, it } from 'vitest'
import { registerBridgeHttpApi, type BridgeHttpRequest, type BridgeHttpResponse } from '../src/http.ts'

describe('listening report HTTP route', () => {
  it('returns the aggregated report with the requested range', async () => {
    let handler!: (request: BridgeHttpRequest, response: BridgeHttpResponse) => void | Promise<void>
    const ranges: string[] = []
    registerBridgeHttpApi({ register: (route) => { handler = route.handler; return () => undefined } }, {
      listeningReport: async (range: string) => { ranges.push(range); return { range, listenMs: 90_000 } },
    } as never)
    const call = async (body: string) => {
      let value = ''
      const response: BridgeHttpResponse = { statusCode: 0, writeHead(status) { response.statusCode = status }, end(body = '') { value = body } }
      const request: BridgeHttpRequest = {
        method: 'POST', url: '/media-bridge/api/listening/report', headers: { host: '127.0.0.1:3080' },
        async *[Symbol.asyncIterator]() { yield body },
      }
      await handler(request, response)
      return { status: response.statusCode, body: JSON.parse(value) as unknown }
    }

    expect(await call('{"range":"today"}')).toMatchObject({ status: 200, body: { ok: true, value: { range: 'today' } } })
    await call('{}')
    expect(ranges).toEqual(['today', 'week'])
  })
})
