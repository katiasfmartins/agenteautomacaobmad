/**
 * Testes do Metrics Writer (Story 2.4, FR-13/SM-5, AD-4, AD-7). `execGit`
 * e sempre um fake injetado -- nunca toca um repositorio git de verdade
 * (mesmo padrao de DI de `llm-client.test.ts`/`pr-reporter.test.ts`: sem
 * chamada real de rede/processo externo).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeEmptySelectionMetric } from './metrics-writer.ts';
import type { ExecGitFn } from './metrics-writer.ts';

function makeTmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'metrics-writer-test-'));
}

function readLogLines(cwd: string): unknown[] {
  const raw = readFileSync(join(cwd, 'metrics', 'pilot-log.jsonl'), 'utf-8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** Fake execGit que registra toda chamada, na ordem, e falha `push` nas N primeiras tentativas. */
function fakeExecGit(options: { failPushTimes?: number } = {}): { execGit: ExecGitFn; calls: string[][] } {
  const { failPushTimes = 0 } = options;
  const calls: string[][] = [];
  let pushAttempts = 0;

  const execGit: ExecGitFn = (args) => {
    calls.push(args);
    if (args[0] === 'push') {
      pushAttempts += 1;
      if (pushAttempts <= failPushTimes) {
        throw new Error(`push rejeitado (simulado, tentativa ${pushAttempts})`);
      }
    }
    return '';
  };

  return { execGit, calls };
}

test('writeEmptySelectionMetric: sai do detached HEAD (git fetch origin main + checkout -B main origin/main) ANTES de add/commit/push', async () => {
  const cwd = makeTmpCwd();
  const { execGit, calls } = fakeExecGit();

  try {
    await writeEmptySelectionMetric({ runId: '123-1', prNumber: 7, cwd, execGit });

    assert.deepEqual(calls[0], ['fetch', 'origin', 'main']);
    assert.deepEqual(calls[1], ['checkout', '-B', 'main', 'origin/main']);

    const fetchIndex = calls.findIndex((c) => c[0] === 'fetch');
    const checkoutIndex = calls.findIndex((c) => c[0] === 'checkout');
    const addIndex = calls.findIndex((c) => c[0] === 'add');
    const commitIndex = calls.findIndex((c) => c.includes('commit'));
    const pushIndex = calls.findIndex((c) => c[0] === 'push');

    assert.ok(fetchIndex === 0, 'fetch deveria ser a primeira chamada de git');
    assert.ok(checkoutIndex === 1, 'checkout -B main origin/main deveria vir logo apos o fetch');
    assert.ok(checkoutIndex < addIndex, 'checkout precisa acontecer antes do git add');
    assert.ok(addIndex < commitIndex, 'add precisa acontecer antes do commit');
    assert.ok(commitIndex < pushIndex, 'commit precisa acontecer antes do push');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeEmptySelectionMetric: cria metrics/ e pilot-log.jsonl se ainda nao existirem, anexa a linha correta', async () => {
  const cwd = makeTmpCwd();
  const { execGit, calls } = fakeExecGit();

  try {
    await writeEmptySelectionMetric({ runId: '123-1', prNumber: 7, cwd, execGit });

    assert.ok(existsSync(join(cwd, 'metrics', 'pilot-log.jsonl')));

    const lines = readLogLines(cwd);
    assert.equal(lines.length, 1);
    const entry = lines[0] as { runId: string; prNumber: number; reason: string; timestamp: string };
    assert.equal(entry.runId, '123-1');
    assert.equal(entry.prNumber, 7);
    assert.equal(entry.reason, 'selecao-vazia');
    assert.ok(typeof entry.timestamp === 'string' && !Number.isNaN(Date.parse(entry.timestamp)));

    // commit com autor github-actions[bot]
    const commitCall = calls.find((c) => c.includes('commit'));
    assert.ok(commitCall, 'esperava uma chamada de commit');
    assert.ok(commitCall!.includes('user.name=github-actions[bot]'));
    assert.ok(commitCall!.some((arg) => arg.includes('41898282+github-actions[bot]@users.noreply.github.com')));

    // commit restrito por pathspec ao proprio arquivo de metricas -- nunca
    // arrasta outra mudanca staged por acidente.
    assert.deepEqual(commitCall!.slice(-2), ['--', 'metrics/pilot-log.jsonl']);

    // push aconteceu sem nenhum pull --rebase (sem conflito)
    assert.equal(calls.filter((c) => c[0] === 'push').length, 1);
    assert.equal(calls.filter((c) => c[0] === 'pull').length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeEmptySelectionMetric: sem conflito de push -> nao lanca, uma unica linha anexada', async () => {
  const cwd = makeTmpCwd();
  const { execGit } = fakeExecGit();

  try {
    await assert.doesNotReject(writeEmptySelectionMetric({ runId: '1-1', prNumber: 1, cwd, execGit }));
    assert.equal(readLogLines(cwd).length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeEmptySelectionMetric: append -- linha nova nunca sobrescreve linhas ja existentes no arquivo', async () => {
  const cwd = makeTmpCwd();

  try {
    await writeEmptySelectionMetric({ runId: '1-1', prNumber: 1, cwd, execGit: fakeExecGit().execGit });
    await writeEmptySelectionMetric({ runId: '2-1', prNumber: 1, cwd, execGit: fakeExecGit().execGit });

    const lines = readLogLines(cwd) as Array<{ runId: string }>;
    assert.equal(lines.length, 2);
    assert.equal(lines[0].runId, '1-1');
    assert.equal(lines[1].runId, '2-1');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test(
  'writeEmptySelectionMetric: conflito de push (1x) -> git pull --rebase, retry, sucede sem lancar',
  { timeout: 10_000 },
  async () => {
    const cwd = makeTmpCwd();
    const { execGit, calls } = fakeExecGit({ failPushTimes: 1 });

    try {
      await assert.doesNotReject(writeEmptySelectionMetric({ runId: '1-1', prNumber: 1, cwd, execGit }));

      const pushCalls = calls.filter((c) => c[0] === 'push');
      const pullCalls = calls.filter((c) => c[0] === 'pull');
      assert.equal(pushCalls.length, 2, 'deveria ter tentado push 2x (1 falha + 1 sucesso)');
      assert.equal(pullCalls.length, 1, 'deveria ter feito exatamente 1 git pull --rebase');
      assert.deepEqual(pullCalls[0], ['pull', '--rebase']);

      // pull --rebase sempre depois do push que falhou, antes do retry
      const pushIndex = calls.findIndex((c) => c[0] === 'push');
      const pullIndex = calls.findIndex((c) => c[0] === 'pull');
      assert.ok(pullIndex > pushIndex);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test(
  'writeEmptySelectionMetric: conflitos de push esgotam os retries (AD-7) -> propaga o erro (fail-closed, AD-4)',
  { timeout: 15_000 },
  async () => {
    const cwd = makeTmpCwd();
    // Falha em TODAS as tentativas (inicial + todos os retries).
    const { execGit, calls } = fakeExecGit({ failPushTimes: Number.POSITIVE_INFINITY });

    try {
      await assert.rejects(writeEmptySelectionMetric({ runId: '1-1', prNumber: 1, cwd, execGit }), /push rejeitado/);

      // A linha de metrica local ainda deveria ter sido escrita (so o
      // push/publicacao falhou) -- perder so a propria linha da run e
      // aceitavel (ver Design Notes da spec 2.4), nunca corrompe outra linha.
      assert.equal(readLogLines(cwd).length, 1);

      const pushCalls = calls.filter((c) => c[0] === 'push');
      const pullCalls = calls.filter((c) => c[0] === 'pull');
      assert.equal(pushCalls.length, 4, '1 tentativa inicial + 3 retries = 4 tentativas de push');
      assert.equal(pullCalls.length, 3, '3 git pull --rebase, um antes de cada retry');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);
