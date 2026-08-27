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
 *   (`test-selection.ts`) sobre esse diff;
 * - registra (log estruturado no stdout) inicio da execucao e o resultado
 *   combinado.
 *
 * Execucao do Playwright e publicacao de comentario ficam para as stories
 * 2.3/2.4 (fora de escopo aqui).
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
}

interface GithubPrEventPayload {
  pull_request?: {
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
 * `head.sha`. Devolve `null` quando: a variavel nao esta setada; o arquivo
 * nao existe/nao e legivel ou nao e JSON valido; o evento nao e de PR; ou
 * `base`/`head` nao parecem um SHA git valido. Em todos os casos o retorno
 * e `null` limpo -- nunca deixa uma excecao propagar (o payload do evento
 * e entrada externa, nao confiavel) -- para que o Orquestrador simplesmente
 * pare sem diff para analisar, sem crash.
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

  if (typeof base !== 'string' || typeof head !== 'string' || !SHA_PATTERN.test(base) || !SHA_PATTERN.test(head)) {
    return null;
  }

  return { base, head };
}

/**
 * Roda `git diff <base>...<head>` localmente (nao via API do GitHub --
 * decisao ja tomada na spec 2.2). Requer historico completo (`fetch-depth: 0`
 * no checkout do workflow).
 */
export function getDiff(shas: PullRequestShas, cwd: string = REPO_ROOT): string {
  return execFileSync('git', ['diff', `${shas.base}...${shas.head}`], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
  });
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

  console.log(
    JSON.stringify({
      event: 'orchestrator_analysis_complete',
      runId: runContext.runId,
      baseSha: shas.base,
      headSha: shas.head,
      areas: areaAnalysisResult.areas,
      selectedTests: testSelectionResult.selectedTests,
      unmappedAreas: testSelectionResult.unmappedAreas,
      timestamp: new Date().toISOString(),
    }),
  );
}

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
