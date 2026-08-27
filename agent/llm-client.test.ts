import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callModel } from './llm-client.ts';
import type { AnthropicLikeClient, AnthropicLikeMessage } from './llm-client.ts';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(CURRENT_DIR, 'schemas', 'area-analysis.v1.json');

function fakeClient(response: AnthropicLikeMessage): AnthropicLikeClient {
  return {
    messages: {
      create: async () => response,
    },
  };
}

/** Captura chamadas de console.log durante `fn` e restaura o original depois. */
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (line: unknown) => {
    lines.push(String(line));
  };

  try {
    await fn();
  } finally {
    console.log = original;
  }

  return lines;
}

test('callModel: client injetado retorna tool_use -> resolve toolInput e loga runId/schemaName/schemaVersion/tokens', async () => {
  const client = fakeClient({
    content: [
      {
        type: 'tool_use',
        name: 'area_analysis',
        input: { areas: ['login'] },
      },
    ],
    usage: { input_tokens: 123, output_tokens: 45 },
  });

  let result: Awaited<ReturnType<typeof callModel>> | undefined;

  const logs = await captureLogs(async () => {
    result = await callModel({
      systemPrompt: 'system',
      userPrompt: 'user',
      schemaPath: SCHEMA_PATH,
      schemaName: 'area-analysis',
      runId: 'run-1',
      client,
    });
  });

  assert.deepEqual(result?.toolInput, { areas: ['login'] });
  assert.equal(result?.inputTokens, 123);
  assert.equal(result?.outputTokens, 45);

  assert.equal(logs.length, 1);
  const logged = JSON.parse(logs[0]);
  assert.equal(logged.event, 'llm_call');
  assert.equal(logged.runId, 'run-1');
  assert.equal(logged.schemaName, 'area-analysis');
  assert.equal(logged.schemaVersion, 'v1');
  assert.equal(logged.inputTokens, 123);
  assert.equal(logged.outputTokens, 45);
});

test('callModel: usage ausente -> tokens logados como 0 (nunca undefined/NaN)', async () => {
  const client = fakeClient({
    content: [{ type: 'tool_use', name: 'area_analysis', input: { areas: [] } }],
  });

  const result = await callModel({
    systemPrompt: 'system',
    userPrompt: 'user',
    schemaPath: SCHEMA_PATH,
    schemaName: 'area-analysis',
    runId: 'run-2',
    client,
  });

  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 0);
});

test('callModel: resposta sem bloco tool_use correspondente -> lanca erro (nunca resolve silenciosamente)', async () => {
  const client = fakeClient({
    content: [{ type: 'text' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  await assert.rejects(
    () =>
      callModel({
        systemPrompt: 'system',
        userPrompt: 'user',
        schemaPath: SCHEMA_PATH,
        schemaName: 'area-analysis',
        runId: 'run-3',
        client,
      }),
    /tool_use/,
  );
});

test('callModel: schema invalido (sem schemaVersion/tool) -> lanca erro', async () => {
  const client = fakeClient({
    content: [{ type: 'tool_use', name: 'area_analysis', input: { areas: [] } }],
  });

  await assert.rejects(() =>
    callModel({
      systemPrompt: 'system',
      userPrompt: 'user',
      schemaPath: join(CURRENT_DIR, 'llm-client.test.ts'), // arquivo real, mas nao e um schema valido
      schemaName: 'area-analysis',
      runId: 'run-4',
      client,
    }),
  );
});
