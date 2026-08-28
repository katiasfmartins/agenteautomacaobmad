/**
 * Estagio de Registro de Metricas (Metrics Writer, FR-13/SM-5, AD-4, AD-7).
 *
 * So roda quando a Selecao de Testes (Story 2.2) devolve `selectedTests`
 * vazio -- decisao de QUANDO chamar fica no Orquestrador (`orchestrator.ts`),
 * nunca aqui. Este modulo so sabe fazer uma coisa: anexar uma linha ao
 * arquivo JSONL de metricas e publicar essa mudanca (commit + push).
 *
 * Anexa `{runId, timestamp, prNumber, reason: 'selecao-vazia'}` a
 * `metrics/pilot-log.jsonl` (cria o diretorio/arquivo se ainda nao
 * existirem -- primeira execucao do pilot). Commit assinado como
 * `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`.
 *
 * `actions/checkout@v4` num workflow disparado por `pull_request` deixa o
 * HEAD detached (checkout na ref sintetica de merge da PR) -- nao ha branch
 * com tracking remoto para um `git push` nu seguir, e ele falharia de cara
 * com "You are not currently on a branch". Por isso, ANTES de escrever o
 * arquivo/commitar, este modulo sempre faz `git fetch origin main` + `git
 * checkout -B main origin/main`: sai do detached HEAD, entra numa branch
 * local `main` de verdade com tracking configurado para `origin/main`
 * (automatico quando o start-point do `checkout -B` e uma remote-tracking
 * branch), pra que a escrita do arquivo, o commit e o `git pull --rebase`/
 * `push` seguintes operem todos contra `main`, independente de em qual ref
 * o checkout do workflow deixou o workspace.
 *
 * Runners do GitHub Actions sao efemeros (checkout novo a cada job), entao
 * o unico jeito de duas runs colidirem e as duas tentando dar push
 * (quase) ao mesmo tempo para o mesmo branch remoto -- a segunda e
 * rejeitada (`non-fast-forward`). Tratamento (AD-7): `git pull --rebase` +
 * novo `push`, ate 3 retries, com backoff crescente (500ms / 1s / 2s) antes
 * de cada um. Esgotar os retries propaga o erro (fail-closed, AD-4) -- o
 * job falha, mesmo tratamento de qualquer outro erro real do Orquestrador.
 * Perder a propria linha de metrica de uma run cancelada a meio do retry
 * (por `cancel-in-progress` do workflow) e aceitavel para dado de auditoria
 * (ver Design Notes da spec 2.4) -- nunca corrompe a linha de outra run,
 * porque cada job so mexe na sua propria linha, anexada uma unica vez.
 *
 * `execGit` e injetavel por parametro (execucao real via `execFileSync`
 * como default), mesmo padrao de DI dos demais estagios (`llm-client.ts`
 * injeta o client Anthropic; `pr-reporter.ts` injeta o client Octokit).
 *
 * Roda via type-stripping nativo do Node -- sintaxe TS aqui precisa
 * continuar "erasable".
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(CURRENT_DIR, '..');

const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

const METRICS_RELATIVE_PATH = join('metrics', 'pilot-log.jsonl');

export type ExecGitFn = (args: string[], cwd: string) => string;

function defaultExecGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

export interface WriteEmptySelectionMetricParams {
  runId: string;
  prNumber: number;
  cwd?: string;
  execGit?: ExecGitFn;
}

// AD-7: ate 3 retries (git pull --rebase + push), cada um precedido por um
// backoff crescente. `BACKOFF_MS_SEQUENCE[i]` e o backoff antes do retry
// `i+1`; seu tamanho (3) e o proprio limite de retries. No total, uma
// sequencia de conflitos consecutivos produz ate 1 (tentativa inicial) + 3
// (retries) = 4 tentativas de `push`, mas somente 3 "falhas apos retry"
// contam para o fail-closed (a 4a falha e a que esgota os retries e
// propaga).
const BACKOFF_MS_SEQUENCE = [500, 1000, 2000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tenta `git push`; em caso de rejeicao (conflito com outra run), faz
 * `git pull --rebase` e tenta de novo, ate `BACKOFF_MS_SEQUENCE.length`
 * vezes, com o backoff correspondente antes de cada retry. Esgotar os
 * retries propaga o erro do ultimo `push` (fail-closed, AD-4) -- nunca
 * engole a falha.
 */
async function pushWithRetry(execGit: ExecGitFn, cwd: string, runId: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      execGit(['push'], cwd);
      if (attempt > 0) {
        console.log(
          JSON.stringify({
            event: 'metrics_writer_push_succeeded_after_retry',
            runId,
            attempt,
          }),
        );
      }
      return;
    } catch (error) {
      if (attempt >= BACKOFF_MS_SEQUENCE.length) {
        console.log(
          JSON.stringify({
            event: 'metrics_writer_push_retries_exhausted',
            runId,
            attempts: attempt + 1,
            error: error instanceof Error ? error.message : String(error),
            detail: 'retries de push esgotados -- propaga erro (fail-closed, AD-4)',
          }),
        );
        throw error;
      }

      const backoffMs = BACKOFF_MS_SEQUENCE[attempt];
      console.log(
        JSON.stringify({
          event: 'metrics_writer_push_conflict_retry',
          runId,
          attempt,
          backoffMs,
          detail: 'push rejeitado (conflito com outra run) -- aguarda backoff, git pull --rebase, tenta de novo',
        }),
      );

      await sleep(backoffMs);
      execGit(['pull', '--rebase'], cwd);
    }
  }
}

/**
 * Anexa a linha de metrica de "selecao vazia" a `metrics/pilot-log.jsonl` e
 * publica (commit + push, com retry em conflito -- AD-7). Cria o
 * diretorio/arquivo se ainda nao existirem.
 */
export async function writeEmptySelectionMetric(params: WriteEmptySelectionMetricParams): Promise<void> {
  const { runId, prNumber, cwd = REPO_ROOT } = params;
  const execGit = params.execGit ?? defaultExecGit;

  // Sai do detached HEAD que `actions/checkout@v4` deixa em workflows de
  // `pull_request` e entra numa `main` local de verdade, com tracking pra
  // `origin/main` -- precisa acontecer ANTES da escrita do arquivo/commit,
  // senao um `checkout -B` subsequente poderia descartar a mudanca local
  // ainda nao commitada.
  execGit(['fetch', 'origin', 'main'], cwd);
  execGit(['checkout', '-B', 'main', 'origin/main'], cwd);

  const metricsDir = join(cwd, 'metrics');
  mkdirSync(metricsDir, { recursive: true });

  const entry = {
    runId,
    timestamp: new Date().toISOString(),
    prNumber,
    reason: 'selecao-vazia',
  };

  appendFileSync(join(cwd, METRICS_RELATIVE_PATH), `${JSON.stringify(entry)}\n`, 'utf-8');

  console.log(
    JSON.stringify({
      event: 'metrics_writer_entry_appended',
      runId,
      prNumber,
    }),
  );

  const gitPath = METRICS_RELATIVE_PATH.replace(/\\/g, '/');

  execGit(['add', gitPath], cwd);
  execGit(
    [
      '-c',
      `user.name=${BOT_NAME}`,
      '-c',
      `user.email=${BOT_EMAIL}`,
      'commit',
      '-m',
      `chore(metrics): registra selecao vazia (run ${runId})`,
      // Pathspec restringe o commit a este arquivo, mesmo que outra coisa
      // ja estivesse staged no working tree por algum outro motivo -- este
      // commit nunca deveria arrastar mudanca alheia junto.
      '--',
      gitPath,
    ],
    cwd,
  );

  await pushWithRetry(execGit, cwd, runId);
}
