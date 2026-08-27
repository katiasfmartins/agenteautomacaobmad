import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunContext } from './orchestrator.ts';

test('resolveRunContext: GITHUB_RUN_ID e GITHUB_RUN_ATTEMPT presentes -> run ID canonico na ordem correta', () => {
  const result = resolveRunContext({
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
  });

  assert.equal(result.runId, '123-1');
  assert.equal(result.source, 'github-actions');
});

test('resolveRunContext: GITHUB_RUN_ID e GITHUB_RUN_ATTEMPT ausentes -> fallback local', () => {
  const result = resolveRunContext({});

  assert.equal(result.runId, 'local-0');
  assert.equal(result.source, 'local-fallback');
});

test('resolveRunContext: apenas GITHUB_RUN_ID presente (sem ATTEMPT) -> fallback local (AND, nao OR)', () => {
  const result = resolveRunContext({
    GITHUB_RUN_ID: '123',
  });

  assert.equal(result.runId, 'local-0');
  assert.equal(result.source, 'local-fallback');
});

test('resolveRunContext: apenas GITHUB_RUN_ATTEMPT presente (sem RUN_ID) -> fallback local (AND, nao OR)', () => {
  const result = resolveRunContext({
    GITHUB_RUN_ATTEMPT: '1',
  });

  assert.equal(result.runId, 'local-0');
  assert.equal(result.source, 'local-fallback');
});
