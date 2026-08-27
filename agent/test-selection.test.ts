import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { selectTests } from './test-selection.ts';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const REAL_TESTS_DIR = join(CURRENT_DIR, '..', 'tests');

function makeTestsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'test-selection-test-'));
  for (const [fileName, content] of Object.entries(files)) {
    writeFileSync(join(dir, fileName), content, 'utf-8');
  }
  return dir;
}

const LOGIN_SPEC = `
import { test, expect } from '@playwright/test';

test.describe('login', { tag: '@login' }, () => {
  test('exemplo', async () => {});
});
`;

const CADASTRO_SPEC = `
import { test, expect } from '@playwright/test';

test.describe('cadastro', { tag: '@cadastro' }, () => {
  test('exemplo', async () => {});
});
`;

const UNTAGGED_SPEC = `
import { test, expect } from '@playwright/test';

test.describe('sem-tag', () => {
  test('exemplo sem tag alguma', async () => {});
});
`;

/** Captura chamadas de console.log durante `fn` e restaura o original depois. */
function captureLogs<T>(fn: () => T): { result?: T; error?: unknown; logs: string[] } {
  const original = console.log;
  const lines: string[] = [];
  console.log = (line: unknown) => {
    lines.push(String(line));
  };

  try {
    const result = fn();
    return { result, logs: lines };
  } catch (error) {
    return { error, logs: lines };
  } finally {
    console.log = original;
  }
}

test('selectTests: area com teste tagueado correspondente -> selecionado, sem lacuna', () => {
  const testsDir = makeTestsDir({
    'login.spec.ts': LOGIN_SPEC,
    'cadastro.spec.ts': CADASTRO_SPEC,
  });

  const result = selectTests({ areas: ['login'], testsDir });

  assert.deepEqual(result.selectedTests, [join(testsDir, 'login.spec.ts')]);
  assert.deepEqual(result.unmappedAreas, []);

  rmSync(testsDir, { recursive: true, force: true });
});

test('selectTests: area sem nenhum teste com tag correspondente -> unmappedAreas, selectedTests vazio (nunca omitido)', () => {
  const testsDir = makeTestsDir({
    'login.spec.ts': LOGIN_SPEC,
  });

  const result = selectTests({ areas: ['listagem'], testsDir });

  assert.deepEqual(result.selectedTests, []);
  assert.deepEqual(result.unmappedAreas, ['listagem']);

  rmSync(testsDir, { recursive: true, force: true });
});

test('selectTests: mistura de areas mapeadas e nao mapeadas -> particiona corretamente', () => {
  const testsDir = makeTestsDir({
    'login.spec.ts': LOGIN_SPEC,
    'cadastro.spec.ts': CADASTRO_SPEC,
  });

  const result = selectTests({ areas: ['login', 'area-desconhecida', 'cadastro'], testsDir });

  assert.deepEqual(
    new Set(result.selectedTests),
    new Set([join(testsDir, 'login.spec.ts'), join(testsDir, 'cadastro.spec.ts')]),
  );
  assert.deepEqual(result.unmappedAreas, ['area-desconhecida']);

  rmSync(testsDir, { recursive: true, force: true });
});

test('selectTests: nao faz match parcial de tag (ex. area "log" nao casa com "@login")', () => {
  const testsDir = makeTestsDir({
    'login.spec.ts': LOGIN_SPEC,
  });

  const result = selectTests({ areas: ['log'], testsDir });

  assert.deepEqual(result.selectedTests, []);
  assert.deepEqual(result.unmappedAreas, ['log']);

  rmSync(testsDir, { recursive: true, force: true });
});

test('selectTests: lista de areas vazia -> nenhum teste selecionado, nenhuma lacuna', () => {
  const testsDir = makeTestsDir({
    'login.spec.ts': LOGIN_SPEC,
  });

  const result = selectTests({ areas: [], testsDir });

  assert.deepEqual(result.selectedTests, []);
  assert.deepEqual(result.unmappedAreas, []);

  rmSync(testsDir, { recursive: true, force: true });
});

test('selectTests: spec sem NENHUMA tag @area -> erro de configuracao (AD-1), interrompe toda a Selecao (lanca excecao, nunca resultado parcial), loga arquivo(s) sem tag', () => {
  const testsDir = makeTestsDir({
    'login.spec.ts': LOGIN_SPEC,
    'sem-tag.spec.ts': UNTAGGED_SPEC,
  });

  const { result, error, logs } = captureLogs(() => selectTests({ areas: ['login'], testsDir }));

  assert.equal(result, undefined, 'nao deveria devolver resultado parcial');
  assert.ok(error instanceof Error, 'esperava excecao lancada');
  assert.match((error as Error).message, /sem-tag\.spec\.ts/);

  const untaggedLog = logs.map((l) => JSON.parse(l)).find((l) => l.event === 'test_selection_untagged_spec_files');
  assert.ok(untaggedLog, 'esperava log com os arquivos sem tag antes de lancar');
  assert.deepEqual(untaggedLog.untaggedFiles, [join(testsDir, 'sem-tag.spec.ts')]);

  rmSync(testsDir, { recursive: true, force: true });
});

test('selectTests (integracao com a Suite Piloto real, Story 1.3): as 3 areas conhecidas casam com os 3 specs reais', () => {
  const result = selectTests({ areas: ['login', 'cadastro', 'listagem'], testsDir: REAL_TESTS_DIR });

  assert.deepEqual(result.unmappedAreas, []);
  assert.deepEqual(
    new Set(result.selectedTests),
    new Set([
      join(REAL_TESTS_DIR, 'login.spec.ts'),
      join(REAL_TESTS_DIR, 'cadastro.spec.ts'),
      join(REAL_TESTS_DIR, 'listagem.spec.ts'),
    ]),
  );
});
