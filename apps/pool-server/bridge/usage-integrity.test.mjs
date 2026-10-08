import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeProtocol } from './protocol.mjs';

const valid = ctx => ctx.usage(1000, 10, true, { cacheReadTokens: 600, cacheWriteTokens: 100 });
const cases = [
  ['final overlapping cache', [valid, ctx => ctx.usage(1000, 10, true, { cacheReadTokens: 900, cacheWriteTokens: 200 })], 'UNKNOWN'],
  ['final fractional cache', [valid, ctx => ctx.usage(1000, 10, true, { cacheReadTokens: 600.5 })], 'UNKNOWN'],
  ['final negative output', [valid, ctx => ctx.usage(1000, -1, true)], 'UNKNOWN'],
  ['invalid then valid stays invalid', [ctx => ctx.usage(1000, 10, true, { cacheReadTokens: -1 }), valid], 'UNKNOWN'],
  ['unsafe accumulated input', [ctx => ctx.usage(Number.MAX_SAFE_INTEGER, 0), ctx => ctx.usage(1, 0)], 'UNKNOWN'],
  ['missing notification preserves valid metrics', [valid, ctx => ctx.usage()], 'KNOWN'],
  ['null empty notification preserves valid metrics', [valid, ctx => ctx.usage(null, null)], 'KNOWN'],
  ['explicit zero is known', [ctx => ctx.usage(0, 0, true)], 'KNOWN'],
];

for (const [name, steps, expected] of cases) {
  test(name, async () => {
    const events = [];
    const protocol = new BridgeProtocol({
      platform: 'CURSOR', runtime: { env: {}, cwd: process.cwd() }, emit: event => events.push(event),
      providerFactory: async () => ({
        async chat(_request, ctx) {
          ctx.text('fixture');
          for (const step of steps) step(ctx);
          return { stopReason: 'end_turn' };
        },
        async close() {},
      }),
      turnTimeoutMs: 1000,
    });
    try {
      await protocol.dispatch({ id: name, method: 'chat', params: { turnId: name, model: 'offline-fixture', messages: [{ role: 'user', content: 'Offline usage fixture' }] } });
      const usage = events.find(event => event.event === 'usage');
      assert.equal(usage?.usageSource, expected);
      if (expected === 'UNKNOWN') {
        assert.equal(usage.inputTokens, null);
        assert.equal(usage.outputTokens, null);
        assert.equal(usage.cacheReadTokens, null);
        assert.equal(usage.cacheWriteTokens, null);
        assert.equal(usage.estimateMethod, undefined);
      }
    } finally {
      await protocol.close();
    }
  });
}
