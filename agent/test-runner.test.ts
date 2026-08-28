/**
 * Testes do Test Runner (Story 2.3). Roda contra a aplicacao-exemplo local
 * de verdade e o Playwright de verdade -- sem mock (Playwright nao depende
 * de API key, ver Code Map da spec 2.3). Exige `npm start` rodando em
 * `http://localhost:3000` antes desta suite (ver README/Verification da
 * spec): sem a app no ar, os testes de `tests/login.spec.ts` falham por
 * timeout de navegacao, nao por bug do Test Runner.
 *
 * Cobre a I/O & Edge-Case Matrix da spec 2.3:
 * - selecao com 1 arquivo -> so esse arquivo roda, evidencia completa;
 * - selecao vazia -> sentinela, zero testes reais, dirs existem mesmo assim;
 * - teste selecionado falha -> nao lanca, exit code nao-zero como dado,
 *   evidencia completa mesmo assim;
 * - binario do Playwright ausente/corrompido -> unico caso que lanca.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runTests, EMPTY_SELECTION_SENTINEL } from './test-runner.ts';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(CURRENT_DIR, '..');
const REAL_TESTS_DIR = join(REPO_ROOT, 'tests');

/** Le e faz parse de test-results/results.json (reporter `json`, FR-7 a FR-11). */
function readJsonReport(jsonReportPath: string): { stats: { expected: number; unexpected: number }; suites: unknown[] } {
  return JSON.parse(readFileSync(jsonReportPath, 'utf-8'));
}

/** Limpa test-results/ e playwright-report/ antes de cada teste, para nenhuma execucao contaminar a proxima (evidencia obsoleta, results.json antigo). */
function cleanOutputDirs(cwd: string): void {
  rmSync(join(cwd, 'test-results'), { recursive: true, force: true });
  rmSync(join(cwd, 'playwright-report'), { recursive: true, force: true });
}

/** Um .spec.ts que sempre falha, tagueado @fail, escrito num arquivo temporario dentro de tests/ real (para rodar com a config real do projeto). */
function writeAlwaysFailingSpec(): { filePath: string; cleanup: () => void } {
  const fileName = `__test_runner_teste_falho__.spec.ts`;
  const filePath = join(REAL_TESTS_DIR, fileName);
  writeFileSync(
    filePath,
    [
      "import { test, expect } from '@playwright/test';",
      '',
      "test.describe('teste-falho-deliberado', { tag: '@fail-deliberado' }, () => {",
      "  test('sempre falha (fixture da suite do test-runner)', async ({ page }) => {",
      "    await page.goto('/login');",
      "    await expect(page.locator('#elemento-que-nao-existe')).toBeVisible({ timeout: 1000 });",
      '  });',
      '});',
      '',
    ].join('\n'),
    'utf-8',
  );
  return {
    filePath,
    cleanup: () => rmSync(filePath, { force: true }),
  };
}

test('runTests: selecao com 1 arquivo -> so esse arquivo roda, evidencia completa (screenshot/video/trace) e results.json', () => {
  cleanOutputDirs(REPO_ROOT);
  const loginSpec = join(REAL_TESTS_DIR, 'login.spec.ts');

  const result = runTests({ selectedTests: [loginSpec] });

  assert.equal(result.exitCode, 0, 'login.spec.ts deveria passar contra a app local');
  assert.ok(existsSync(result.testResultsDir), 'test-results/ deveria existir');
  assert.ok(existsSync(result.playwrightReportDir), 'playwright-report/ deveria existir');
  assert.ok(existsSync(result.jsonReportPath), 'results.json deveria existir');
  assert.ok(existsSync(join(result.playwrightReportDir, 'index.html')), 'playwright-report/index.html deveria existir');

  const report = readJsonReport(result.jsonReportPath);
  assert.equal(report.stats.expected, 2, 'os 2 testes de login.spec.ts deveriam ter rodado e passado');
  assert.equal(report.stats.unexpected, 0);

  // Evidencia completa por teste: procura ao menos um screenshot, um video e
  // um trace em algum subdiretorio de test-results/ (nomes de pasta variam
  // por titulo do teste, entao varremos por extensao em vez de path fixo).
  const entries = readdirSync(result.testResultsDir, { withFileTypes: true, recursive: true });
  const names: string[] = entries.filter((e) => e.isFile()).map((e) => e.name);
  assert.ok(names.some((n) => n.endsWith('.png')), 'esperava ao menos um screenshot (.png)');
  assert.ok(names.some((n) => n.endsWith('.webm')), 'esperava ao menos um video (.webm)');
  assert.ok(names.some((n) => n === 'trace.zip'), 'esperava ao menos um trace (trace.zip)');
});

test('runTests: outros specs nao selecionados nao rodam nessa run (so o subconjunto exato)', () => {
  cleanOutputDirs(REPO_ROOT);
  const loginSpec = join(REAL_TESTS_DIR, 'login.spec.ts');

  const result = runTests({ selectedTests: [loginSpec] });
  const report = readJsonReport(result.jsonReportPath);

  // login.spec.ts tem 2 testes (describe 'login'). Se cadastro.spec.ts ou
  // listagem.spec.ts tivessem rodado tambem, o total de testes no relatorio
  // seria maior que 2.
  assert.equal(report.stats.expected + report.stats.unexpected, 2);
});

test('runTests: selecao vazia -> usa sentinela, zero testes reais rodam, test-results/playwright-report existem mesmo assim (AD-3)', () => {
  cleanOutputDirs(REPO_ROOT);

  const result = runTests({ selectedTests: [] });

  assert.ok(existsSync(result.testResultsDir), 'test-results/ deveria existir mesmo com selecao vazia');
  assert.ok(existsSync(result.playwrightReportDir), 'playwright-report/ deveria existir mesmo com selecao vazia');
  assert.ok(existsSync(result.jsonReportPath), 'results.json deveria existir mesmo com selecao vazia');

  const report = readJsonReport(result.jsonReportPath);
  assert.equal(report.suites.length, 0, 'nenhum teste real deveria ter rodado (sentinela nao corresponde a spec algum)');
});

test('runTests: caminho sentinela reservado nunca corresponde a nenhum spec real existente em tests/ (incluindo subpastas)', () => {
  // `recursive: true` para tambem pegar uma eventual colisao com um spec de
  // mesmo nome dentro de uma subpasta de tests/, nao so na raiz.
  const realSpecPaths = new Set(
    readdirSync(REAL_TESTS_DIR, { recursive: true })
      .map((entry) => String(entry).replace(/\\/g, '/'))
      .filter((relativePath) => relativePath.endsWith('.spec.ts')),
  );
  const sentinelRelativePath = EMPTY_SELECTION_SENTINEL.replace(/^tests\//, '');
  assert.ok(
    !realSpecPaths.has(sentinelRelativePath),
    'o sentinela nao pode coincidir com um spec real de tests/ (em qualquer nivel de subpasta)',
  );
});

test('runTests: teste selecionado falha -> nao lanca, devolve exit code nao-zero como dado, evidencia completa mesmo assim', () => {
  cleanOutputDirs(REPO_ROOT);
  const { filePath: failingSpec, cleanup } = writeAlwaysFailingSpec();

  try {
    let result: ReturnType<typeof runTests> | undefined;
    assert.doesNotThrow(() => {
      result = runTests({ selectedTests: [failingSpec] });
    }, 'test-runner nunca deveria lancar por causa de resultado de teste (passe/falhe)');

    assert.ok(result, 'esperava resultado devolvido, nao excecao');
    assert.notEqual(result!.exitCode, 0, 'exit code deveria ser nao-zero (o teste falhou de proposito)');

    const report = readJsonReport(result!.jsonReportPath);
    assert.equal(report.stats.unexpected, 1, 'o teste deliberadamente falho deveria estar registrado como unexpected');

    // Evidencia completa mesmo em teste falho.
    const entries = readdirSync(result!.testResultsDir, { withFileTypes: true, recursive: true });
    const names: string[] = entries.filter((e) => e.isFile()).map((e) => e.name);
    assert.ok(names.some((n) => n.endsWith('.png')), 'esperava screenshot mesmo em teste falho');
    assert.ok(names.some((n) => n.endsWith('.webm')), 'esperava video mesmo em teste falho');
    assert.ok(names.some((n) => n === 'trace.zip'), 'esperava trace mesmo em teste falho');
  } finally {
    cleanup();
  }
});

test('runTests: binario do Playwright ausente/corrompido -> unico caso real de erro, test-runner lanca', () => {
  cleanOutputDirs(REPO_ROOT);

  // Simula "binario corrompido" removendo de verdade o entry point que o
  // shim `node_modules/.bin/playwright(.cmd)` invoca -- sem mock de nenhuma
  // funcao deste projeto, so um estado real de instalacao quebrada,
  // restaurado no finally.
  const cliPath = join(REPO_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
  const backupPath = `${cliPath}.bak-test-runner-spec`;

  assert.ok(existsSync(cliPath), 'pre-condicao: cli.js do Playwright precisa existir antes do teste corromper');
  renameSync(cliPath, backupPath);

  try {
    assert.throws(
      () => runTests({ selectedTests: [join(REAL_TESTS_DIR, 'login.spec.ts')] }),
      'test-runner deveria lancar quando o Playwright nao consegue nem iniciar (erro de execucao real, nao resultado de teste)',
    );
  } finally {
    renameSync(backupPath, cliPath);
  }
});

test('runTests: garante test-results/ e playwright-report/ mesmo se a execucao falhar sem nunca comecar (instalacao do Playwright ausente nesse cwd)', () => {
  const tmpCwd = mkdtempSync(join(tmpdir(), 'test-runner-dirs-'));
  // cwd minimo sem test-results/, playwright-report/ nem node_modules --
  // runTests precisa garantir os dois primeiros via mkdirSync recursive
  // mesmo que o Playwright (ausente nesse cwd) nunca chegue a rodar.
  try {
    assert.throws(() => runTests({ selectedTests: ['tests/login.spec.ts'], cwd: tmpCwd }));
    assert.ok(existsSync(join(tmpCwd, 'test-results')), 'test-results/ deveria ser garantido mesmo apos falha de execucao');
    assert.ok(existsSync(join(tmpCwd, 'playwright-report')), 'playwright-report/ deveria ser garantido mesmo apos falha de execucao');
  } finally {
    rmSync(tmpCwd, { recursive: true, force: true });
  }
});
