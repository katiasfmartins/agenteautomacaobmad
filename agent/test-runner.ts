/**
 * Estagio de Execucao dos Testes (Test Runner, FR-6 a FR-11, AD-3).
 *
 * Roda o Playwright test runner com os caminhos exatos de `selectedTests`
 * como argumentos posicionais -- nunca omite argumentos de arquivo, mesmo
 * quando a selecao esta vazia (evita o default do CLI de rodar a suite
 * inteira, AD-3). Selecao vazia usa `EMPTY_SELECTION_SENTINEL`, um caminho
 * reservado que nunca corresponde a um spec real: o Playwright reporta "No
 * tests found" (exit code != 0) mas ainda assim escreve `results.json`/
 * `playwright-report/`, entao o contrato de saida (dirs sempre existentes)
 * se mantem sem precisar de nenhum caso especial aqui.
 *
 * DESVIO DELIBERADO da redacao literal da spec ("roda `npx playwright
 * test`"): em vez de `spawn`ar `npx` via shell, este modulo resolve e
 * invoca diretamente o entry point local do Playwright
 * (`node_modules/@playwright/test/cli.js`, o mesmo arquivo que o shim
 * `node_modules/.bin/playwright(.cmd)` chama) via `process.execPath`, sem
 * shell. Motivo, comprovado neste repositorio: no Windows, `npx` so pode
 * ser spawnado com `shell: true` (o shim e um `.cmd`), e `shell: true`
 * corrompe silenciosamente argumentos de arquivo com espaco no caminho --
 * o caminho real deste repo (`.../Projetos IA/...`) tem espaco. O efeito
 * observado nao foi um erro claro: foi o Playwright rodando a suite
 * INTEIRA em vez do subconjunto selecionado -- exatamente a violacao que
 * AD-3 existe para proibir. Invocar o entry point diretamente via
 * `process.execPath` (sem shell) elimina essa classe de bug inteira,
 * preservando o comportamento pretendido pela spec (mesmo runner, mesmos
 * argumentos posicionais exatos, mesma saida) de forma robusta em qualquer
 * caminho de diretorio.
 *
 * `screenshot`/`video`/`trace` sempre ligados e o reporter `json` adicional
 * (`test-results/results.json`) sao responsabilidade de `playwright.config.ts`
 * (FR-7 a FR-11) -- este modulo so invoca o Playwright e devolve dados.
 *
 * Nunca lanca nem falha por causa de RESULTADO de teste (passe ou falhe) --
 * so por erro de execucao real (binario do Playwright ausente/corrompido,
 * processo morto por sinal). O sinal usado para distinguir os dois casos e
 * puramente observavel: se o processo nunca chegou a escrever
 * `results.json`, o Playwright nunca rodou de verdade (erro de
 * config/infra) -- lanca. Se `results.json` existe, o Playwright rodou (o
 * exit code, seja 0 ou nao, e resultado de teste) -- nunca lanca, devolve
 * como dado.
 *
 * Upload do artefato (`test-results/`/`playwright-report/`) e subida da
 * aplicacao-exemplo NUNCA sao responsabilidade deste modulo (AD-3, AD-11)
 * -- ambos sao steps do workflow YAML.
 *
 * Roda via type-stripping nativo do Node -- sintaxe TS aqui precisa
 * continuar "erasable".
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(CURRENT_DIR, '..');

/**
 * Caminho sentinela reservado para selecao vazia. Nunca corresponde a
 * nenhum spec real (nenhum arquivo com esse nome existe nem deve ser
 * criado em `tests/`) -- usado como argumento posicional no lugar de
 * `selectedTests` quando a lista esta vazia, para nunca omitir argumentos
 * de arquivo da chamada ao Playwright (AD-3).
 */
export const EMPTY_SELECTION_SENTINEL = 'tests/__selecao_vazia__.spec.ts';

export interface RunTestsParams {
  selectedTests: string[];
  cwd?: string;
}

export interface RunTestsResult {
  exitCode: number;
  testResultsDir: string;
  playwrightReportDir: string;
  jsonReportPath: string;
}

/**
 * O Playwright trata argumentos de arquivo como padroes/regex casados
 * contra o caminho resolvido do spec. Um caminho absoluto no Windows usa
 * `\` (separador nativo), que dentro de uma regex e um caractere de escape
 * -- sequencias como `\P` ou `\a` nao viram o literal esperado e o match
 * falha silenciosamente ("No tests found"). Normalizar para `/` (aceito
 * pelo Playwright em qualquer plataforma) evita essa classe de bug; em
 * POSIX e um no-op.
 */
function normalizeForPlaywrightArg(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function runTests(params: RunTestsParams): RunTestsResult {
  const { selectedTests, cwd = REPO_ROOT } = params;

  const testResultsDir = join(cwd, 'test-results');
  const playwrightReportDir = join(cwd, 'playwright-report');
  const jsonReportPath = join(testResultsDir, 'results.json');

  const usedSentinel = selectedTests.length === 0;
  const fileArgs = (usedSentinel ? [EMPTY_SELECTION_SENTINEL] : selectedTests).map(normalizeForPlaywrightArg);

  console.log(
    JSON.stringify({
      event: 'test_runner_started',
      selectedTestsCount: selectedTests.length,
      usedSentinel,
      cwd,
    }),
  );

  // Limpa test-results/ e playwright-report/ inteiros (nao so results.json)
  // de uma execucao anterior antes de rodar: sem isso (a) a checagem de "o
  // Playwright rodou de verdade" abaixo poderia dar falso negativo (achar
  // que rodou porque um results.json antigo ainda esta la), mascarando um
  // erro real desta execucao; e (b) evidencia (screenshots/videos/traces)
  // de um subconjunto de testes diferente rodado antes poderia ficar
  // misturada com a evidencia desta execucao, quebrando a garantia de
  // "evidencia completa" da story.
  rmSync(testResultsDir, { recursive: true, force: true });
  rmSync(playwrightReportDir, { recursive: true, force: true });

  // Entry point local do Playwright (o mesmo que node_modules/.bin/playwright
  // chama). Invocado via `process.execPath` sem shell -- ver nota de desvio
  // no topo do arquivo. Se este arquivo nao existir (instalacao ausente ou
  // corrompida), o Node abaixo falha ao carregar o modulo antes de rodar
  // qualquer teste -- exatamente o caso de erro real que este modulo deve
  // propagar (detectado adiante pela ausencia de `results.json`).
  const playwrightCliPath = join(cwd, 'node_modules', '@playwright', 'test', 'cli.js');

  const result = spawnSync(process.execPath, [playwrightCliPath, 'test', ...fileArgs], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
  });

  // Garante que os diretorios de saida existam ao final, mesmo se o
  // Playwright nunca chegou a cria-los (ex.: falhou antes de escrever
  // qualquer coisa) -- nunca link morto no comentario da PR (Story 2.4).
  mkdirSync(testResultsDir, { recursive: true });
  mkdirSync(playwrightReportDir, { recursive: true });

  // `results.json` so existe se o Playwright de fato rodou (chegou a
  // reportar, ainda que 0 testes tenham casado com o sentinela). Sua
  // ausencia e o sinal observavel de que a execucao nunca comecou de
  // verdade -- binario ausente/corrompido, erro de config, processo morto
  // por sinal etc. (o unico caso de erro real desta story). Presenca do
  // arquivo, por outro lado, significa que o exit code -- 0 ou nao -- e
  // resultado de teste, nunca motivo para lancar.
  const jsonReportExists = existsSync(jsonReportPath);

  // Falha real de spawn (ex.: nem o executavel do Node pode ser
  // encontrado/iniciado) -- nao e resultado de teste, e erro de execucao.
  // So conta como erro real se `results.json` TAMBEM estiver ausente:
  // `spawnSync` pode setar `result.error` (ex.: ENOBUFS por estourar o
  // `maxBuffer` de stdout/stderr) mesmo depois do processo do Playwright ja
  // ter rodado por completo e escrito o relatorio -- nesse caso e um
  // resultado de teste genuino, nunca motivo para lancar (contrato deste
  // modulo).
  if (result.error && !jsonReportExists) {
    console.log(
      JSON.stringify({
        event: 'test_runner_spawn_failed',
        error: result.error.message,
        detail: 'processo do Playwright nao pode nem ser iniciado -- erro de execucao real, test-runner lanca',
      }),
    );
    throw result.error;
  }

  if (result.error && jsonReportExists) {
    console.log(
      JSON.stringify({
        event: 'test_runner_spawn_error_ignored',
        error: result.error.message,
        detail:
          'spawnSync sinalizou result.error, mas results.json existe -- Playwright rodou de verdade, ' +
          'erro tratado como nao-fatal (ex.: ENOBUFS de maxBuffer apos o processo ja ter terminado)',
      }),
    );
  }

  if (!jsonReportExists) {
    const detail =
      'test-results/results.json nao foi criado -- Playwright nao chegou a rodar de verdade ' +
      '(binario ausente/corrompido ou outro erro de config/infra, nao resultado de teste)';

    console.log(
      JSON.stringify({
        event: 'test_runner_execution_failed',
        exitCode: result.status,
        signal: result.signal,
        stderr: (result.stderr ?? '').slice(0, 4000),
        detail,
      }),
    );

    throw new Error(
      `runTests: ${detail}. exitCode=${String(result.status)} signal=${String(result.signal)}\n${(result.stderr ?? '').slice(0, 4000)}`,
    );
  }

  const exitCode = result.status ?? 1;

  console.log(
    JSON.stringify({
      event: 'test_runner_completed',
      exitCode,
      selectedTestsCount: selectedTests.length,
      usedSentinel,
      testResultsDir,
      playwrightReportDir,
      jsonReportPath,
    }),
  );

  return { exitCode, testResultsDir, playwrightReportDir, jsonReportPath };
}
