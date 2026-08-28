/**
 * Ponto de entrada do Orquestrador.
 *
 * Story 2.1 cobre apenas resolucao do run ID canonico. Esta story (2.2)
 * fecha o pipeline de analise:
 * - le GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT do ambiente uma unica vez;
 * - monta o run ID canonico `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}` (AD-2);
 * - le `GITHUB_EVENT_PATH` (payload do evento da PR) e extrai `base.sha`/
 *   `head.sha`;
 * - roda `git diff <base>...<head>` localmente (nao via API do GitHub --
 *   decisao ja tomada, ver spec 2.2 Ask First) para obter o diff da PR;
 * - encadeia Analise de Area (`area-analysis.ts`) -> Selecao de Testes
 *   (`test-selection.ts`) -> Execucao dos Testes (`test-runner.ts`, Story
 *   2.3) sobre esse diff;
 * - registra (log estruturado no stdout) inicio da execucao e o resultado
 *   combinado (analise + selecao + execucao).
 *
 * `runTests` (Story 2.3) nunca lanca por resultado de teste (passe/falhe) --
 * exit code e caminhos locais viram dado no log combinado. Se lancar, e por
 * erro real de execucao (config/infra), e propaga normalmente ate o
 * `main().catch(...)` abaixo, que loga e falha o processo -- mesmo
 * tratamento de qualquer outro erro do pipeline.
 *
 * Publicacao de comentario na PR (Story 2.4) fecha o pipeline: apos
 * `runTests`, `reportToPR` (`pr-reporter.ts`) roda SEMPRE -- publica ou
 * atualiza o unico comentario marcado desta PR (AD-5) com o resultado da
 * analise/selecao/execucao. `writeEmptySelectionMetric`
 * (`metrics-writer.ts`) so roda quando `selectedTests` veio vazio --
 * registra esse caso em `metrics/pilot-log.jsonl` (FR-13/SM-5).
 *
 * Ambos podem lancar (erro real de rede/API do GitHub, ou retries de push
 * do Metrics Writer esgotados, AD-4) -- mas rodam de forma INDEPENDENTE
 * (cada um no seu proprio try/catch): um erro no PR Reporter nunca impede a
 * tentativa do Metrics Writer, e vice-versa. Erro(s) coletado(s) sao
 * relancados (como `AggregateError`) so depois de ambos terem tido a chance
 * de rodar, propagando ate o `main().catch(...)` abaixo -- o job ainda
 * falha (fail-closed, AD-4) se qualquer um dos dois falhou, mesmo
 * tratamento de qualquer outro erro do pipeline.
 *
 * Este arquivo roda via type-stripping nativo do Node (`node agent/orchestrator.ts`),
 * sem `tsc`/`tsx`/`ts-node` e sem passo de build (decisao deliberada, ver spec
 * Design Notes). Isso significa que a sintaxe TS usada aqui precisa continuar
 * "erasable" -- sem enums, sem namespaces, sem nada que exija transformacao
 * real de codigo, so remocao de anotacoes de tipo.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeAreas } from './area-analysis.ts';
import { selectTests } from './test-selection.ts';
import { runTests } from './test-runner.ts';
import { buildCommentBody, reportToPR } from './pr-reporter.ts';
import { writeEmptySelectionMetric } from './metrics-writer.ts';

// Só roda o pipeline quando este arquivo e o entry point do processo (`node
// agent/orchestrator.ts`) -- nunca como efeito colateral de outro modulo
// importar as funcoes puras exportadas aqui (ex.: orchestrator.test.ts).
const IS_ENTRY_POINT = process.argv[1] === fileURLToPath(import.meta.url);

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(CURRENT_DIR, '..');
const AREAS_FILE_PATH = join(REPO_ROOT, 'areas.yaml');
const TESTS_DIR = join(REPO_ROOT, 'tests');

export interface RunContext {
  runId: string;
  source: 'github-actions' | 'local-fallback';
}

export interface PullRequestShas {
  base: string;
  head: string;
  number: number;
}

interface GithubPrEventPayload {
  pull_request?: {
    number?: unknown;
    base?: { sha?: unknown };
    head?: { sha?: unknown };
  };
}

// SHA hex (curto ou completo) -- qualquer valor que nao bata e tratado como
// ausencia de shas validos (retorno null), nunca repassado adiante.
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

export function resolveRunContext(env: NodeJS.ProcessEnv): RunContext {
  const githubRunId = env.GITHUB_RUN_ID;
  const githubRunAttempt = env.GITHUB_RUN_ATTEMPT;

  if (githubRunId && githubRunAttempt) {
    return {
      runId: `${githubRunId}-${githubRunAttempt}`,
      source: 'github-actions',
    };
  }

  return {
    runId: 'local-0',
    source: 'local-fallback',
  };
}

/**
 * Le o payload do evento da PR (`GITHUB_EVENT_PATH`) e extrai `base.sha` /
 * `head.sha` / `pull_request.number` (este ultimo, Story 2.4, necessario
 * para o PR Reporter/Metrics Writer saberem em qual PR publicar). Devolve
 * `null` quando: a variavel nao esta setada; o arquivo nao existe/nao e
 * legivel ou nao e JSON valido; o evento nao e de PR; `base`/`head` nao
 * parecem um SHA git valido; ou `number` nao e um inteiro positivo. Em
 * todos os casos o retorno e `null` limpo -- nunca deixa uma excecao
 * propagar (o payload do evento e entrada externa, nao confiavel) -- para
 * que o Orquestrador simplesmente pare sem diff para analisar, sem crash.
 */
export function readPullRequestShas(eventPath: string | undefined): PullRequestShas | null {
  if (!eventPath) {
    return null;
  }

  let event: GithubPrEventPayload;
  try {
    const raw = readFileSync(eventPath, 'utf-8');
    event = JSON.parse(raw) as GithubPrEventPayload;
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'orchestrator_event_payload_unreadable',
        eventPath,
        error: error instanceof Error ? error.message : String(error),
        detail: 'GITHUB_EVENT_PATH ilegivel ou com JSON invalido -- tratado como ausencia de shas (retorno null, sem crash)',
      }),
    );
    return null;
  }

  const base = event.pull_request?.base?.sha;
  const head = event.pull_request?.head?.sha;
  const number = event.pull_request?.number;

  if (typeof base !== 'string' || typeof head !== 'string' || !SHA_PATTERN.test(base) || !SHA_PATTERN.test(head)) {
    return null;
  }

  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
    return null;
  }

  return { base, head, number };
}

/**
 * Roda `git diff <base>...<head>` localmente (nao via API do GitHub --
 * decisao ja tomada na spec 2.2). Requer historico completo (`fetch-depth: 0`
 * no checkout do workflow).
 */
export function getDiff(shas: Pick<PullRequestShas, 'base' | 'head'>, cwd: string = REPO_ROOT): string {
  return execFileSync('git', ['diff', `${shas.base}...${shas.head}`], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

/**
 * Separa `GITHUB_REPOSITORY` (formato fixo `owner/repo` do GitHub Actions)
 * em `{owner, repo}`. Ausente/mal-formado e erro real de configuracao (nao
 * um caso esperado, ja que este ponto do pipeline so e alcancado quando ja
 * ha uma PR de verdade sendo processada) -- lanca, propagando ate
 * `main().catch(...)` como qualquer outro erro do Orquestrador.
 */
export function parseGithubRepository(value: string | undefined): { owner: string; repo: string } {
  const parts = (value ?? '').split('/');

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `orchestrator: GITHUB_REPOSITORY ausente ou mal-formado (esperado "owner/repo", recebido "${String(value)}")`,
    );
  }

  return { owner: parts[0], repo: parts[1] };
}

/**
 * URL do run completo (nunca de um arquivo/artefato individual, ver spec
 * 2.4 Always) -- usada tanto no link de evidencia do comentario quanto no
 * marcador que identifica o run atual.
 */
export function buildRunUrl(owner: string, repo: string, githubRunId: string): string {
  return `https://github.com/${owner}/${repo}/actions/runs/${githubRunId}`;
}

async function main(): Promise<void> {
  const runContext = resolveRunContext(process.env);

  console.log(
    JSON.stringify({
      event: 'orchestrator_started',
      runId: runContext.runId,
      source: runContext.source,
      timestamp: new Date().toISOString(),
    }),
  );

  const shas = readPullRequestShas(process.env.GITHUB_EVENT_PATH);

  if (!shas) {
    console.log(
      JSON.stringify({
        event: 'orchestrator_skipped_no_pr_shas',
        runId: runContext.runId,
        detail: 'GITHUB_EVENT_PATH ausente ou payload sem pull_request.base/head.sha -- nada para analisar',
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }

  const diff = getDiff(shas);

  const areaAnalysisResult = await analyzeAreas({
    diff,
    areasFilePath: AREAS_FILE_PATH,
    runId: runContext.runId,
  });

  const testSelectionResult = selectTests({
    areas: areaAnalysisResult.areas,
    testsDir: TESTS_DIR,
  });

  // Roda exatamente o subconjunto selecionado (Story 2.3, AD-3). `runTests`
  // nunca lanca por resultado de teste -- exit code e caminhos locais sao
  // apenas dados aqui, reportados no comentario da PR abaixo (Story 2.4).
  // Falhar o JOB por resultado de teste continua fora de escopo (Epic 3).
  const testRunResult = runTests({
    selectedTests: testSelectionResult.selectedTests,
  });

  // Marcador/link de evidencia (Story 2.4) usam sempre o GITHUB_RUN_ID cru
  // (nunca o runId composto `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}` usado
  // no restante do log deste arquivo): reruns do mesmo run (novo attempt)
  // devem continuar encontrando/atualizando o MESMO comentario e apontando
  // para a MESMA URL de run (o attempt nao entra na URL do run no GitHub
  // Actions). Fallback pro runId composto so serve pro modo local-fallback
  // (sem GITHUB_RUN_ID de verdade), pra nunca publicar o literal "undefined".
  const githubRunId = process.env.GITHUB_RUN_ID ?? runContext.runId;
  const { owner, repo } = parseGithubRepository(process.env.GITHUB_REPOSITORY);
  const runUrl = buildRunUrl(owner, repo, githubRunId);

  const commentBody = buildCommentBody({
    areas: areaAnalysisResult.areas,
    selectedTests: testSelectionResult.selectedTests,
    unmappedAreas: testSelectionResult.unmappedAreas,
    jsonReportPath: testRunResult.jsonReportPath,
    runUrl,
  });

  // PR Reporter e Metrics Writer sao independentes um do outro -- cada um
  // roda dentro do seu proprio try/catch, entao um erro de um NUNCA impede
  // a tentativa do outro (ex.: se `reportToPR` lancar, a linha de metrica
  // de selecao vazia ainda assim e tentada, nunca silenciosamente pulada).
  // Erro(s) coletado(s) sao relancados no final, depois de ambos terem
  // tido a chance de rodar -- job ainda falha (fail-closed, AD-4) se
  // qualquer um dos dois falhou, mesmo tratamento de qualquer outro erro
  // real do Orquestrador.
  const stageErrors: unknown[] = [];
  let reportResult: Awaited<ReturnType<typeof reportToPR>> | undefined;

  // Publica/atualiza o unico comentario marcado desta PR -- SEMPRE (AD-5),
  // independente do resultado dos testes ou de `selectedTests` estar vazio.
  try {
    reportResult = await reportToPR({
      owner,
      repo,
      prNumber: shas.number,
      runId: githubRunId,
      body: commentBody,
    });
  } catch (error) {
    stageErrors.push(error);
    console.log(
      JSON.stringify({
        event: 'orchestrator_pr_report_failed',
        runId: runContext.runId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  // Metrics Writer (FR-13/SM-5) so roda quando a Selecao de Testes veio
  // vazia -- decisao de QUANDO chamar e responsabilidade do Orquestrador,
  // nunca do proprio `metrics-writer.ts`.
  if (testSelectionResult.selectedTests.length === 0) {
    try {
      await writeEmptySelectionMetric({
        runId: runContext.runId,
        prNumber: shas.number,
      });
    } catch (error) {
      stageErrors.push(error);
      console.log(
        JSON.stringify({
          event: 'orchestrator_metrics_writer_failed',
          runId: runContext.runId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  if (stageErrors.length > 0) {
    const combinedMessage = stageErrors.map((error) => (error instanceof Error ? error.message : String(error))).join(' | ');
    throw new AggregateError(
      stageErrors,
      `orchestrator: PR Reporter e/ou Metrics Writer falharam (${stageErrors.length} erro(s)): ${combinedMessage}`,
    );
  }

  console.log(
    JSON.stringify({
      event: 'orchestrator_run_complete',
      runId: runContext.runId,
      baseSha: shas.base,
      headSha: shas.head,
      areas: areaAnalysisResult.areas,
      selectedTests: testSelectionResult.selectedTests,
      unmappedAreas: testSelectionResult.unmappedAreas,
      testRunExitCode: testRunResult.exitCode,
      testResultsDir: testRunResult.testResultsDir,
      playwrightReportDir: testRunResult.playwrightReportDir,
      jsonReportPath: testRunResult.jsonReportPath,
      prNumber: shas.number,
      // Garantido definido aqui: se `reportToPR` tivesse falhado,
      // `stageErrors` teria disparado o throw acima antes deste ponto.
      prCommentAction: reportResult!.action,
      timestamp: new Date().toISOString(),
    }),
  );
}

if (IS_ENTRY_POINT) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: 'orchestrator_failed',
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
    process.exitCode = 1;
  });
}
