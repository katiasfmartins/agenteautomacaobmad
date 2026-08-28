/**
 * Estagio de Publicacao de Comentario na PR (PR Reporter, FR-12, AD-3,
 * AD-5, AD-10).
 *
 * Duas partes deliberadamente separadas:
 * - `buildCommentBody` -- pura, le `results.json` (relatorio `json` do
 *   Playwright, escrito por `test-runner.ts`/Story 2.3) do disco local e
 *   monta o corpo Markdown do comentario. Nenhuma chamada de rede aqui.
 * - `reportToPR` -- I/O real via `@octokit/rest`: busca o comentario ja
 *   marcado nesta PR (se existir), decide criar ou atualizar, nunca
 *   deleta/recria (AD-5).
 *
 * Marcador (AD-5): toda publicacao embute `<!-- agente-testes:v1
 * run=<runId> -->` ao final do corpo. Busca de comentario existente e pelo
 * PREFIXO do marcador (`<!-- agente-testes:v1`, sem o `run=...`) como
 * substring em qualquer parte do corpo -- nunca pelo marcador completo
 * (que inclui o run ID de um run especifico) -- assim runs subsequentes na
 * mesma PR encontram o comentario de um run anterior (com outro run ID) e
 * o atualizam, em vez de criar um novo. Se por algum motivo anomalo
 * existir mais de um comentario marcado, usa o mais recente por
 * `created_at` (nunca lanca, nunca apaga o(s) outro(s)).
 *
 * Autenticacao do Octokit e SEMPRE via `GITHUB_TOKEN` (AD-10) -- ao
 * contrario do SDK da Anthropic (`llm-client.ts`), o `@octokit/rest` NAO le
 * a variavel de ambiente sozinho: o token precisa ser passado explicitamente
 * como `auth` na construcao do client default.
 *
 * `octokit` e injetavel por parametro (client real como default), mesmo
 * padrao de DI de `llm-client.ts` (client injetavel) -- testavel sem
 * chamada de rede.
 *
 * Duracao reportada e sempre o total por teste (soma de todas as tentativas
 * em `test.results[]`), nunca por step -- timing por step so existe no
 * trace nativo (mesmo raciocinio da spec 2.3, ver Design Notes).
 *
 * Excerto de erro de teste falho (`results[].errors[0].message`, truncado a
 * 500 chars) passa por `redactSecrets` antes de entrar no corpo do
 * comentario -- o link de evidencia (`runUrl`) nunca precisa dessa
 * varredura (e sempre a URL fixa do run, nunca conteudo do usuario/modelo).
 *
 * Roda via type-stripping nativo do Node -- sintaxe TS aqui precisa
 * continuar "erasable".
 */

import { readFileSync } from 'node:fs';
import { Octokit } from '@octokit/rest';

// ---------------------------------------------------------------------------
// buildCommentBody -- puro
// ---------------------------------------------------------------------------

export interface BuildCommentBodyParams {
  areas: string[];
  selectedTests: string[];
  unmappedAreas: string[];
  jsonReportPath: string;
  runUrl: string;
}

interface PlaywrightJsonError {
  message?: unknown;
}

interface PlaywrightJsonResult {
  status?: unknown;
  duration?: unknown;
  errors?: PlaywrightJsonError[];
}

interface PlaywrightJsonTest {
  status?: unknown;
  results?: PlaywrightJsonResult[];
}

interface PlaywrightJsonSpec {
  title?: unknown;
  tests?: PlaywrightJsonTest[];
}

interface PlaywrightJsonSuite {
  title?: unknown;
  specs?: PlaywrightJsonSpec[];
  suites?: PlaywrightJsonSuite[];
}

interface PlaywrightJsonReport {
  suites?: PlaywrightJsonSuite[];
}

interface FlatTestResult {
  title: string;
  status: string;
  durationMs: number;
  errorMessage: string | null;
}

// Padroes de segredo conhecidos (AD documentado na spec 2.4): chave da
// Anthropic (`sk-ant-...`), tokens classicos do GitHub (`gh[pousr]_...` --
// pessoal, oauth, user-to-server, server-to-server de app, refresh), PATs
// de granularidade fina do GitHub (`github_pat_...`), cabecalho `Bearer
// <token>` generico, e Access Key ID da AWS (`AKIA` + 16 alfanumericos).
// Cada ocorrencia -- token inteiro, incluindo o prefixo -- vira
// `[REDACTED]`.
//
// Classes de caractere do "resto do token" incluem `/+=` alem de
// alfanumerico/`_-`: tokens reais (JWTs, bases64-ish) frequentemente contem
// esses simbolos: uma classe estreita demais so redige um PREFIXO do
// segredo, deixando o restante vazar em claro no comentario publicado. A
// unica excecao e o Access Key ID da AWS (`AKIA...`): formato fixo (sempre
// exatamente 16 alfanumericos maiusculos apos o prefixo), entao nao ha
// "resto variavel" pra alargar.
const SECRET_TOKEN_CHAR_CLASS = 'A-Za-z0-9_\\-/+=';
const SECRET_PATTERNS: RegExp[] = [
  new RegExp(`sk-ant-[${SECRET_TOKEN_CHAR_CLASS}]+`, 'g'),
  new RegExp(`gh[pousr]_[${SECRET_TOKEN_CHAR_CLASS}]+`, 'g'),
  new RegExp(`github_pat_[${SECRET_TOKEN_CHAR_CLASS}]+`, 'g'),
  new RegExp(`Bearer\\s+[${SECRET_TOKEN_CHAR_CLASS}.]+`, 'gi'),
  /AKIA[0-9A-Z]{16}/g,
];

/**
 * Substitui qualquer trecho que bata com um padrao de segredo conhecido por
 * `[REDACTED]`. Nunca lanca -- entrada sempre e uma string (mensagem de
 * erro de teste), nunca dado estruturado.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

function readPlaywrightReport(jsonReportPath: string): PlaywrightJsonReport {
  const raw = readFileSync(jsonReportPath, 'utf-8');
  return JSON.parse(raw) as PlaywrightJsonReport;
}

/**
 * Achata a arvore de suites (arquivo -> describe -> ... -> specs) em uma
 * lista plana de testes. O titulo de suite de arquivo (`*.spec.ts`) e
 * omitido do caminho exibido -- ja redundante com o proprio agrupamento do
 * comentario -- mantendo so os titulos de `describe` (se houver) + o titulo
 * do spec.
 */
function collectTestResults(suites: PlaywrightJsonSuite[] | undefined, pathParts: string[] = []): FlatTestResult[] {
  const out: FlatTestResult[] = [];

  for (const suite of suites ?? []) {
    const title = typeof suite.title === 'string' ? suite.title : '';
    const isFileSuite = /\.(spec|test)\.[cm]?[jt]sx?$/.test(title);
    const nextPathParts = title && !isFileSuite ? [...pathParts, title] : pathParts;

    for (const spec of suite.specs ?? []) {
      const specTitle = typeof spec.title === 'string' ? spec.title : '(sem titulo)';
      const fullTitle = [...nextPathParts, specTitle].join(' > ');

      for (const t of spec.tests ?? []) {
        const results = t.results ?? [];
        const durationMs = results.reduce((sum, r) => sum + (typeof r.duration === 'number' ? r.duration : 0), 0);

        const failingResult = results.find((r) => Array.isArray(r.errors) && r.errors.length > 0);
        const rawMessage = failingResult?.errors?.[0]?.message;

        out.push({
          title: fullTitle,
          status: typeof t.status === 'string' ? t.status : 'unknown',
          durationMs,
          errorMessage: typeof rawMessage === 'string' ? rawMessage : null,
        });
      }
    }

    out.push(...collectTestResults(suite.suites, nextPathParts));
  }

  return out;
}

function statusEmoji(status: string): string {
  switch (status) {
    case 'expected':
      return '✅';
    case 'unexpected':
      return '❌';
    case 'flaky':
      return '⚠️';
    case 'skipped':
      return '⏭️';
    default:
      return '❔';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'expected':
      return 'passou';
    case 'unexpected':
      return 'falhou';
    case 'flaky':
      return 'instavel (flaky)';
    case 'skipped':
      return 'pulado';
    default:
      return status;
  }
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * Escapa `|` e crase antes de interpolar num texto Markdown (celula de
 * tabela, ou o cabecalho do excerto de erro que reusa o mesmo titulo) --
 * um titulo de teste/describe com `|` literal quebraria o layout da
 * tabela; backslash e escapado primeiro para nao escapar em dobro.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`');
}

const ERROR_EXCERPT_MAX_CHARS = 500;

// GitHub limita o corpo de um comentario a ~65536 chars; 60000 deixa uma
// margem segura (a nota de truncamento acrescenta uns poucos chars a mais).
// Uma suite grande com muitas falhas poderia facilmente estourar isso --
// sem o guard, `createComment`/`updateComment` falhariam com 422.
const MAX_COMMENT_BODY_CHARS = 60_000;

function finalizeCommentBody(lines: string[], runUrl: string): string {
  const assembled = lines.join('\n');

  if (assembled.length <= MAX_COMMENT_BODY_CHARS) {
    return assembled;
  }

  const truncated = assembled.slice(0, MAX_COMMENT_BODY_CHARS);
  return `${truncated}\n\n_(comentario truncado -- resultado completo em ${runUrl})_`;
}

/**
 * Monta o corpo Markdown do comentario. Puro -- unica I/O e a leitura local
 * de `jsonReportPath` (mesmo raciocinio de `analyzeAreas` lendo
 * `areasFilePath`), nunca chamada de rede.
 *
 * Selecao vazia (AD-3): diz "nenhum teste selecionado", sem tabela de
 * testes e sem link de evidencia -- nem chega a ler `jsonReportPath`.
 *
 * Corpo montado passa por `finalizeCommentBody`: se ultrapassar
 * `MAX_COMMENT_BODY_CHARS`, e truncado com uma nota apontando pro `runUrl`
 * -- guarda contra o limite de tamanho de comentario do GitHub (~65536
 * chars), que uma suite grande com muitas falhas poderia estourar.
 */
export function buildCommentBody(params: BuildCommentBodyParams): string {
  const { areas, selectedTests, unmappedAreas, jsonReportPath, runUrl } = params;

  const lines: string[] = ['## Resultado do Agente de Testes', ''];

  lines.push(`**Areas identificadas:** ${areas.length > 0 ? areas.join(', ') : '_nenhuma_'}`);
  if (unmappedAreas.length > 0) {
    lines.push(`**Areas sem testes mapeados:** ${unmappedAreas.join(', ')}`);
  }

  if (selectedTests.length === 0) {
    lines.push('');
    lines.push('Nenhum teste selecionado.');
    return finalizeCommentBody(lines, runUrl);
  }

  const report = readPlaywrightReport(jsonReportPath);
  const flatResults = collectTestResults(report.suites);

  lines.push('');
  lines.push('| Teste | Resultado | Duracao |');
  lines.push('|---|---|---|');

  const failedExcerpts: Array<{ title: string; excerpt: string }> = [];

  for (const result of flatResults) {
    const escapedTitle = escapeMarkdown(result.title);
    lines.push(
      `| ${escapedTitle} | ${statusEmoji(result.status)} ${statusLabel(result.status)} | ${formatDuration(result.durationMs)} |`,
    );

    if ((result.status === 'unexpected' || result.status === 'flaky') && result.errorMessage) {
      const excerpt = redactSecrets(result.errorMessage.slice(0, ERROR_EXCERPT_MAX_CHARS));
      failedExcerpts.push({ title: escapedTitle, excerpt });
    }
  }

  if (failedExcerpts.length > 0) {
    lines.push('');
    lines.push('### Excertos de erro');
    for (const { title, excerpt } of failedExcerpts) {
      lines.push('');
      lines.push(`**${title}**`);
      lines.push('```');
      lines.push(excerpt);
      lines.push('```');
    }
  }

  lines.push('');
  lines.push(`[Ver evidencia completa do run](${runUrl})`);

  return finalizeCommentBody(lines, runUrl);
}

// ---------------------------------------------------------------------------
// reportToPR -- I/O real
// ---------------------------------------------------------------------------

/**
 * Prefixo usado para BUSCAR um comentario ja publicado por este Agente
 * (AD-5). Deliberadamente sem `run=...`: um run novo precisa encontrar o
 * comentario de um run anterior para atualiza-lo, nunca so o do proprio run
 * atual (que, na primeira publicacao deste run, nem existe ainda).
 */
export const MARKER_PREFIX = '<!-- agente-testes:v1';

function buildMarker(runId: string): string {
  return `${MARKER_PREFIX} run=${runId} -->`;
}

interface OctokitComment {
  id: number;
  body?: string | null;
  created_at: string;
  user?: { type?: string } | null;
}

export interface OctokitLikeClient {
  rest: {
    issues: {
      listComments: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page: number;
        page: number;
      }) => Promise<{ data: OctokitComment[] }>;
      createComment: (params: { owner: string; repo: string; issue_number: number; body: string }) => Promise<{
        data: { id: number };
      }>;
      updateComment: (params: { owner: string; repo: string; comment_id: number; body: string }) => Promise<{
        data: { id: number };
      }>;
    };
  };
}

export interface ReportToPRParams {
  owner: string;
  repo: string;
  prNumber: number;
  runId: string;
  body: string;
  octokit?: OctokitLikeClient;
}

export interface ReportToPRResult {
  commentId: number;
  action: 'created' | 'updated';
}

const LIST_COMMENTS_PER_PAGE = 100;

/** Pagina todos os comentarios da PR (nunca assume que cabem numa pagina). */
async function listAllComments(
  client: OctokitLikeClient,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<OctokitComment[]> {
  const all: OctokitComment[] = [];
  let page = 1;

  for (;;) {
    const { data } = await client.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: LIST_COMMENTS_PER_PAGE,
      page,
    });
    all.push(...data);

    if (data.length < LIST_COMMENTS_PER_PAGE) {
      break;
    }
    page += 1;
  }

  return all;
}

/**
 * Entre os comentarios que contem o prefixo do marcador E foram postados
 * por um bot, devolve o mais recente por `created_at`. Multiplos marcados
 * e um estado anomalo (nunca deveria acontecer se este modulo sempre
 * atualiza em vez de criar), mas nunca lanca nem apaga os demais -- so
 * ignora os mais antigos.
 */
function findLatestMarkedComment(comments: OctokitComment[]): OctokitComment | null {
  // O marcador e sempre embutido ao FINAL do corpo publicado (ver
  // `reportToPR`), nunca no inicio -- por isso a busca e por substring
  // (`includes`), nunca `startsWith`. Exige tambem `user.type === 'Bot'`:
  // um comentario de humano que por acaso cite/cole o texto do marcador
  // (ex.: discutindo este proprio Agente) nunca deveria ser tratado como
  // "nosso" e sobrescrito -- so um comentario de bot marcado conta.
  const marked = comments.filter(
    (c) => typeof c.body === 'string' && c.body.includes(MARKER_PREFIX) && c.user?.type === 'Bot',
  );

  if (marked.length === 0) {
    return null;
  }

  return marked.reduce((latest, candidate) =>
    new Date(candidate.created_at).getTime() > new Date(latest.created_at).getTime() ? candidate : latest,
  );
}

function createDefaultClient(): OctokitLikeClient {
  // Autenticacao SOMENTE via GITHUB_TOKEN (AD-10) -- passado explicitamente,
  // ao contrario do client da Anthropic, o Octokit nao le a variavel de
  // ambiente sozinho. Validado aqui (em vez de deixar o Octokit tentar sem
  // auth) para que a ausencia da variavel vire um erro de configuracao
  // claro, nunca um 401 opaco la na frente na primeira chamada de API --
  // mesmo raciocinio de `parseGithubRepository` em `orchestrator.ts`.
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    throw new Error(
      'pr-reporter: GITHUB_TOKEN ausente ou vazio -- autenticacao do Octokit exige essa variavel de ambiente (AD-10)',
    );
  }

  return new Octokit({ auth: token }) as unknown as OctokitLikeClient;
}

/**
 * Busca o comentario ja marcado nesta PR (se existir) e decide: existe ->
 * atualiza (nunca cria um segundo); nao existe -> cria. O marcador do run
 * atual e sempre embutido no corpo publicado, ao final.
 */
export async function reportToPR(params: ReportToPRParams): Promise<ReportToPRResult> {
  const { owner, repo, prNumber, runId, body } = params;
  const octokit = params.octokit ?? createDefaultClient();

  const fullBody = `${body}\n\n${buildMarker(runId)}`;

  const comments = await listAllComments(octokit, owner, repo, prNumber);
  const existing = findLatestMarkedComment(comments);

  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: fullBody });
    console.log(
      JSON.stringify({
        event: 'pr_reporter_comment_updated',
        runId,
        prNumber,
        commentId: existing.id,
      }),
    );
    return { commentId: existing.id, action: 'updated' };
  }

  const created = await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: fullBody });
  console.log(
    JSON.stringify({
      event: 'pr_reporter_comment_created',
      runId,
      prNumber,
      commentId: created.data.id,
    }),
  );
  return { commentId: created.data.id, action: 'created' };
}
