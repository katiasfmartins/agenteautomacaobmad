import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRunContext, readPullRequestShas, getDiff } from './orchestrator.ts';

// Dois primeiros commits reais da historia do repositorio-piloto (ordem
// cronologica). Fixados por SHA completo para o teste de `getDiff` ser
// deterministico independente de quando/onde rodar.
const FIRST_COMMIT = '48b85102ba87b577a3aa106a383b043abb17e303'; // bootstrap aplicacao-exemplo
const SECOND_COMMIT = '9d6eb2d95eb9464394744ed729823d26bf03eb14'; // configura framework Playwright e taxonomia de area

function writeEventFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-test-'));
  const filePath = join(dir, 'event.json');
  writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content), 'utf-8');
  return filePath;
}

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

test('readPullRequestShas: payload valido -> shas corretos', () => {
  const eventPath = writeEventFile({
    pull_request: {
      base: { sha: FIRST_COMMIT },
      head: { sha: SECOND_COMMIT },
    },
  });

  const result = readPullRequestShas(eventPath);

  assert.deepEqual(result, { base: FIRST_COMMIT, head: SECOND_COMMIT });

  rmSync(eventPath, { force: true });
});

test('readPullRequestShas: GITHUB_EVENT_PATH ausente -> null', () => {
  assert.equal(readPullRequestShas(undefined), null);
});

test('readPullRequestShas: evento sem pull_request -> null', () => {
  const eventPath = writeEventFile({ action: 'opened' });

  assert.equal(readPullRequestShas(eventPath), null);

  rmSync(eventPath, { force: true });
});

test('readPullRequestShas: base/head ausentes -> null', () => {
  const eventPath = writeEventFile({ pull_request: {} });

  assert.equal(readPullRequestShas(eventPath), null);

  rmSync(eventPath, { force: true });
});

test('readPullRequestShas: base/head vazios -> null', () => {
  const eventPath = writeEventFile({
    pull_request: { base: { sha: '' }, head: { sha: '' } },
  });

  assert.equal(readPullRequestShas(eventPath), null);

  rmSync(eventPath, { force: true });
});

test('readPullRequestShas: JSON invalido -> null, sem lancar excecao (nunca crasha)', () => {
  const eventPath = writeEventFile('{ isto nao e json valido');

  assert.doesNotThrow(() => {
    const result = readPullRequestShas(eventPath);
    assert.equal(result, null);
  });

  rmSync(eventPath, { force: true });
});

test('readPullRequestShas: arquivo inexistente -> null, sem lancar excecao (nunca crasha)', () => {
  assert.doesNotThrow(() => {
    const result = readPullRequestShas(join(tmpdir(), 'este-arquivo-nao-existe-de-verdade.json'));
    assert.equal(result, null);
  });
});

test('readPullRequestShas: base/head com formato invalido de SHA (nao-hex) -> null', () => {
  const eventPath = writeEventFile({
    pull_request: { base: { sha: 'nao-e-um-sha-hex!' }, head: { sha: SECOND_COMMIT } },
  });

  assert.equal(readPullRequestShas(eventPath), null);

  rmSync(eventPath, { force: true });
});

test('getDiff: base...head (ordem correta) produz o diff das mudancas introduzidas pelo head', () => {
  const diff = getDiff({ base: FIRST_COMMIT, head: SECOND_COMMIT });

  assert.match(diff, /areas\.yaml/);
  assert.match(diff, /playwright\.config\.ts/);
});

test('getDiff: argumentos invertidos (head...base) NAO produz o mesmo diff -- confirma que a ordem importa', () => {
  const forward = getDiff({ base: FIRST_COMMIT, head: SECOND_COMMIT });
  const reversed = getDiff({ base: SECOND_COMMIT, head: FIRST_COMMIT });

  assert.notEqual(reversed, forward);
  // FIRST_COMMIT e ancestral de SECOND_COMMIT, entao o merge-base de
  // (SECOND_COMMIT, FIRST_COMMIT) e o proprio FIRST_COMMIT -- diff contra
  // ele mesmo e vazio. Prova objetiva de que `base...head` (nao invertido)
  // e a ordem certa para "o que o head mudou desde que divergiu do base".
  assert.equal(reversed, '');
});
