import { describe, expect, it } from 'vitest'
import { registerBridgeHttpApi } from '../src/http.ts'

function setup(runtime: unknown) {
  let handler!: (request: any, response: any) => void | Promise<void>
  registerBridgeHttpApi({ register: (route) => { handler = route.handler; return () => undefined } }, runtime as any)
  const response = {
    statusCode: 0,
    writeHead: (status: number) => { response.statusCode = status },
    end: (body = '') => { response.body = body },
    body: '',
  }
  const request = (url: string, bodyText: string) => ({
    method: 'POST',
    url,
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() { yield bodyText },
  })
  return { handler, response, request }
}

describe('POST /media-bridge/api/diagnose', () => {
  it('returns the sanitized self-check payload through the standard envelope', async () => {
    const { handler, response, request } = setup({
      diagnoseForUi: async () => ({ playerId: 'qq-music', generatedAt: 1, checks: [], probes: {}, report: 'sanitized' }),
    })

    await handler(request('/media-bridge/api/diagnose', '{}'), response)
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ ok: true, value: { playerId: 'qq-music', generatedAt: 1, checks: [], probes: {}, report: 'sanitized' } })
  })

  it('surfaces probe failures as the envelope error without leaking a stack', async () => {
    const { handler, response, request } = setup({
      diagnoseForUi: async () => { throw new Error('diagnostics exploded at D:\\secret\\path.ps1') },
    })

    await handler(request('/media-bridge/api/diagnose', '{}'), response)
    expect(response.statusCode).toBe(400)
    const payload = JSON.parse(response.body)
    expect(payload.ok).toBe(false)
    expect(payload.error).toContain('diagnostics exploded')
  })
})
