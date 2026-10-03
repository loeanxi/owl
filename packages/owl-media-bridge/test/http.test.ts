import { describe, expect, it } from 'vitest'
import { parseMediaCommand, registerBridgeHttpApi, type BridgeHttpRequest, type BridgeHttpResponse } from '../src/http.ts'

function harness(runtime: Record<string, unknown>) {
  let handler!: (request: BridgeHttpRequest, response: BridgeHttpResponse) => void | Promise<void>
  registerBridgeHttpApi({ register: (route) => { handler = route.handler; return () => undefined } }, runtime as never)
  const call = async (path: string, body = '{}', headers: Record<string, string> = { host: '127.0.0.1:3080' }) => {
    let responseBody = ''
    const response: BridgeHttpResponse = {
      statusCode: 0,
      writeHead(status) { response.statusCode = status },
      end(value = '') { responseBody = value },
    }
    const request: BridgeHttpRequest = { method: 'POST', url: path, headers, async *[Symbol.asyncIterator]() { yield body } }
    await handler(request, response)
    return { status: response.statusCode, body: JSON.parse(responseBody) as unknown }
  }
  return { call }
}

describe('media bridge HTTP API', () => {
  it('parses the application-volume command', () => {
    expect(parseMediaCommand({ kind: 'set-volume', volumePercent: 35 })).toEqual({ kind: 'set-volume', volumePercent: 35 })
  })

  it('rejects requests without an origin-defining Host header', async () => {
    const result = await harness({}).call('/media-bridge/api/status', '{}', {})
    expect(result.status).toBe(403)
  })

  it('serves browser status and validated control routes', async () => {
    const commands: unknown[] = []
    const api = harness({
      statusForUi: async () => ({ state: 'paused' }),
      controlFromUi: async (command: unknown) => { commands.push(command) },
    })

    expect(await api.call('/media-bridge/api/status')).toMatchObject({ status: 200, body: { ok: true, value: { state: 'paused' } } })
    expect(await api.call('/media-bridge/api/control', '{"kind":"play-pause"}')).toMatchObject({ status: 200 })
    expect(commands).toEqual([{ kind: 'play-pause' }])
  })

  it('keeps volume fade and config update routes', async () => {
    const calls: unknown[] = []
    const api = harness({
      fadeFromUi: async (volume: number, duration: number) => { calls.push(['fade', volume, duration]) },
      updateConfig: (value: unknown) => { calls.push(['config', value]); return value },
      statusForUi: async () => ({ state: 'playing' }),
    })

    await api.call('/media-bridge/api/volume/fade', '{"volumePercent":30,"durationSeconds":4}')
    await api.call('/media-bridge/api/config/update', '{"allowAgentControl":true}')
    expect(calls).toEqual([
      ['fade', 30, 4],
      ['config', { allowAgentControl: true }],
    ])
  })

  it('parses preferLiveVideo in config updates and rejects non-boolean values', async () => {
    const calls: unknown[] = []
    const api = harness({
      updateConfig: (value: unknown) => { calls.push(value); return value },
    })
    await api.call('/media-bridge/api/config/update', '{"preferLiveVideo":true}')
    expect(calls).toEqual([{ preferLiveVideo: true }])
    expect((await api.call('/media-bridge/api/config/update', '{"preferLiveVideo":"yes"}')).status).toBe(400)
  })

  it('records the browser live-state mirror and validates its shape', async () => {
    const calls: unknown[] = []
    const api = harness({
      reportLiveState: (state: unknown) => { calls.push(state) },
    })
    expect(await api.call('/media-bridge/api/live/state', '{"active":true,"playing":true}')).toMatchObject({ status: 200, body: { ok: true, value: { reported: true } } })
    await api.call('/media-bridge/api/live/state', '{"active":false}')
    expect(calls).toEqual([{ active: true, playing: true }, { active: false }])
    expect((await api.call('/media-bridge/api/live/state', '{"playing":"yes"}')).status).toBe(400)
  })

  it('returns not-found for removed discovery, scene, timer, and presentation routes', async () => {
    const api = harness({})
    for (const path of ['/media-bridge/api/similar', '/media-bridge/api/search', '/media-bridge/api/focus/scene', '/media-bridge/api/sleep/start', '/media-bridge/api/pomodoro/start', '/media-bridge/api/privacy']) {
      expect((await api.call(path)).status).toBe(404)
    }
  })
})
