import assert from 'node:assert/strict';
import { evaluationRunView } from '../packages/coding-agent/dist/core/evaluation/.live-process-candidate.mjs';
const run = {
  id: 'isolated-projection', profiles: [],
  groups: [{ taskId: 'task', sample: 1, revealed: false, resultIds: ['result'] }],
  results: [{ id: 'result', taskId: 'task', sample: 1, profileId: 'hidden-profile', status: 'running', output: '', thinking: 'supplier thinking delta', generationPhase: 'thinking', startedAt: 'hidden-time', usage: { total: 123 }, costUsd: 12, actualModel: { provider: 'hidden-provider' } }],
};
const first = evaluationRunView(run).results[0];
assert.equal(first.thinking, 'supplier thinking delta');
assert.equal(first.generationPhase, 'thinking');
for (const field of ['profile', 'profileId', 'startedAt', 'usage', 'costUsd', 'actualModel']) assert.equal(Object.hasOwn(first, field), false);
run.results[0].status = 'completed';
assert.equal(Object.hasOwn(evaluationRunView(run).results[0], 'generationPhase'), false);
console.log('Compiled candidate loads and returns thinking without model identity or metrics. No service or model was started.');
