/**
 * Ponto de entrada minimo do Orquestrador.
 *
 * Nesta story (2.1), o Orquestrador apenas:
 * - le GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT do ambiente uma unica vez;
 * - monta o run ID canonico `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}` (AD-2);
 * - registra (log estruturado no stdout) que a execucao comecou.
 *
 * Analise de diff, selecao de testes, execucao do Playwright e publicacao de
 * comentario ficam para as stories 2.2+ (fora de escopo aqui).
 *
 * Este arquivo roda via type-stripping nativo do Node (`node agent/orchestrator.ts`),
 * sem `tsc`/`tsx`/`ts-node` e sem passo de build (decisao deliberada, ver spec
 * Design Notes). Isso significa que a sintaxe TS usada aqui precisa continuar
 * "erasable" -- sem enums, sem namespaces, sem nada que exija transformacao
 * real de codigo, so remocao de anotacoes de tipo.
 */

export interface RunContext {
  runId: string;
  source: 'github-actions' | 'local-fallback';
}

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

function main(): void {
  const runContext = resolveRunContext(process.env);

  const logEntry = {
    event: 'orchestrator_started',
    runId: runContext.runId,
    source: runContext.source,
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(logEntry));
}

main();
