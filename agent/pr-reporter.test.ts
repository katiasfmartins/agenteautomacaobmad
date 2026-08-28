import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCommentBody, redactSecrets, reportToPR, MARKER_PREFIX } from './pr-reporter.ts';
import type { OctokitLikeClient } from './pr-reporter.ts';

const RUN_URL = 'https://github.com/minha-org/meu-repo/actions/runs/999';

function writeResultsJson(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr-reporter-test-'));
  const filePath = join(dir, 'results.json');
  writeFileSync(filePath, JSON.stringify(content), 'utf-8');
  return filePath;
}

/** Relatorio `json` minimo do Playwright, no formato real (ver test-runner.test.ts / manual inspection). */
function makeReport(specsBySuite: Array<{ fileTitle: string; describeTitle: string; specs: unknown[] }>) {
  return {
    suites: specsBySuite.map((s) => ({
      title: s.fileTitle,
      file: s.fileTitle,
      specs: [],
      suites: [
        {
          title: s.describeTitle,
          specs: s.specs,
        },
      ],
    })),
    errors: [],
    stats: {},
  };
}

function passingSpec(title: string, durationMs: number) {
  return {
    title,
    ok: true,
    tests: [
      {
        status: 'expected',
        results: [{ status: 'passed', duration: durationMs, errors: [] }],
      },
    ],
  };
}

function failingSpec(title: string, durationMs: number, errorMessage: string) {
  return {
    title,
    ok: false,
    tests: [
      {
        status: 'unexpected',
        results: [{ status: 'failed', duration: durationMs, errors: [{ message: errorMessage }] }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// buildCommentBody
// ---------------------------------------------------------------------------

test('buildCommentBody: selecao vazia -> "nenhum teste selecionado", sem link de evidencia (AD-3), nunca le jsonReportPath', () => {
  const body = buildCommentBody({
    areas: ['login'],
    selectedTests: [],
    unmappedAreas: [],
    jsonReportPath: join(tmpdir(), 'este-arquivo-nao-existe-de-verdade.json'),
    runUrl: RUN_URL,
  });

  assert.match(body, /Nenhum teste selecionado\./);
  assert.doesNotMatch(body, new RegExp(RUN_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('buildCommentBody: selecao com testes -> lista cada teste com resultado/duracao e link para o run (nunca arquivo individual)', () => {
  const jsonReportPath = writeResultsJson(
    makeReport([
      {
        fileTitle: 'login.spec.ts',
        describeTitle: 'login',
        specs: [passingSpec('login valido navega para /listagem', 2897), passingSpec('login invalido exibe erro', 1204)],
      },
    ]),
  );

  const body = buildCommentBody({
    areas: ['login'],
    selectedTests: [join('tests', 'login.spec.ts')],
    unmappedAreas: [],
    jsonReportPath,
    runUrl: RUN_URL,
  });

  assert.match(body, /login > login valido navega para \/listagem/);
  assert.match(body, /2\.9s/);
  assert.match(body, /login > login invalido exibe erro/);
  assert.match(body, /1\.2s/);
  assert.match(body, /passou/);
  assert.match(body, new RegExp(RUN_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  rmSync(jsonReportPath, { force: true });
});

test('buildCommentBody: areas sem testes mapeados aparecem no corpo', () => {
  const jsonReportPath = writeResultsJson(makeReport([]));

  const body = buildCommentBody({
    areas: ['login', 'area-desconhecida'],
    selectedTests: ['tests/login.spec.ts'],
    unmappedAreas: ['area-desconhecida'],
    jsonReportPath,
    runUrl: RUN_URL,
  });

  assert.match(body, /Areas sem testes mapeados.*area-desconhecida/);

  rmSync(jsonReportPath, { force: true });
});

test('buildCommentBody: teste falho com segredo na mensagem -> excerto no comentario vira [REDACTED]', () => {
  const jsonReportPath = writeResultsJson(
    makeReport([
      {
        fileTitle: 'login.spec.ts',
        describeTitle: 'login',
        specs: [failingSpec('login falha', 500, 'Authorization: Bearer sk-ant-api03-SEGREDOAAAA falhou')],
      },
    ]),
  );

  const body = buildCommentBody({
    areas: ['login'],
    selectedTests: ['tests/login.spec.ts'],
    unmappedAreas: [],
    jsonReportPath,
    runUrl: RUN_URL,
  });

  assert.match(body, /falhou/); // resultado listado
  assert.doesNotMatch(body, /sk-ant-api03-SEGREDOAAAA/);
  assert.match(body, /\[REDACTED\]/);

  rmSync(jsonReportPath, { force: true });
});

test('buildCommentBody: excerto de erro truncado a 500 chars antes de redigir', () => {
  const longMessage = `${'x'.repeat(600)}sk-ant-segredo-no-final`;
  const jsonReportPath = writeResultsJson(
    makeReport([
      {
        fileTitle: 'login.spec.ts',
        describeTitle: 'login',
        specs: [failingSpec('login falha', 500, longMessage)],
      },
    ]),
  );

  const body = buildCommentBody({
    areas: ['login'],
    selectedTests: ['tests/login.spec.ts'],
    unmappedAreas: [],
    jsonReportPath,
    runUrl: RUN_URL,
  });

  // O segredo estava depois do char 500 -- truncamento aconteceu antes da
  // redacao, entao nunca deveria aparecer nem redigido nem em claro.
  assert.doesNotMatch(body, /sk-ant-segredo-no-final/);
  assert.doesNotMatch(body, /\[REDACTED\]/);

  rmSync(jsonReportPath, { force: true });
});

test('buildCommentBody: titulo de teste com "|" e crase -> escapado, nunca quebra o layout da tabela Markdown', () => {
  const jsonReportPath = writeResultsJson(
    makeReport([
      {
        fileTitle: 'login.spec.ts',
        describeTitle: 'login',
        specs: [passingSpec('titulo com | pipe e `crase` literais', 1000)],
      },
    ]),
  );

  const body = buildCommentBody({
    areas: ['login'],
    selectedTests: ['tests/login.spec.ts'],
    unmappedAreas: [],
    jsonReportPath,
    runUrl: RUN_URL,
  });

  assert.match(body, /titulo com \\\| pipe e \\`crase\\` literais/);

  // A linha da tabela precisa ter exatamente 3 celulas (4 pipes delimitadores,
  // ja que o pipe literal do titulo foi escapado com backslash) -- confirma
  // que o "|" do titulo nao virou um delimitador de coluna a mais.
  const tableRow = body.split('\n').find((line) => line.includes('titulo com'));
  assert.ok(tableRow, 'esperava encontrar a linha da tabela com o titulo');
  assert.equal((tableRow!.match(/(?<!\\)\|/g) ?? []).length, 4, 'deveria ter exatamente 4 pipes NAO escapados (delimitadores de 3 celulas)');

  rmSync(jsonReportPath, { force: true });
});

test('buildCommentBody: corpo montado alem do limite seguro -> truncado com nota apontando pro runUrl (guard contra o limite de comentario do GitHub)', () => {
  // Gera especificacoes suficientes pra estourar MAX_COMMENT_BODY_CHARS
  // (60000) com titulos razoavelmente longos.
  const manySpecs = Array.from({ length: 2000 }, (_, i) =>
    passingSpec(`teste numero ${i} com um titulo relativamente longo pra somar volume`, 1000),
  );
  const jsonReportPath = writeResultsJson(
    makeReport([{ fileTitle: 'login.spec.ts', describeTitle: 'login', specs: manySpecs }]),
  );

  const body = buildCommentBody({
    areas: ['login'],
    selectedTests: ['tests/login.spec.ts'],
    unmappedAreas: [],
    jsonReportPath,
    runUrl: RUN_URL,
  });

  assert.ok(body.length < 61_000, `corpo deveria ter sido truncado, tamanho real: ${body.length}`);
  assert.match(body, /comentario truncado/);
  assert.match(body, new RegExp(RUN_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  rmSync(jsonReportPath, { force: true });
});

test('buildCommentBody: corpo dentro do limite seguro -> nunca truncado, nenhuma nota de truncamento', () => {
  const jsonReportPath = writeResultsJson(
    makeReport([
      {
        fileTitle: 'login.spec.ts',
        describeTitle: 'login',
        specs: [passingSpec('login valido', 1000)],
      },
    ]),
  );

  const body = buildCommentBody({
    areas: ['login'],
    selectedTests: ['tests/login.spec.ts'],
    unmappedAreas: [],
    jsonReportPath,
    runUrl: RUN_URL,
  });

  assert.doesNotMatch(body, /comentario truncado/);

  rmSync(jsonReportPath, { force: true });
});

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

test('redactSecrets: redige cada padrao de segredo conhecido', () => {
  assert.equal(redactSecrets('key=sk-ant-api03-abcDEF123_-'), 'key=[REDACTED]');
  assert.equal(redactSecrets('token=ghp_1234567890abcdef'), 'token=[REDACTED]');
  assert.equal(redactSecrets('token=gho_abcdef123456'), 'token=[REDACTED]');
  assert.equal(redactSecrets('Authorization: Bearer abc123.def-456_ghi'), 'Authorization: [REDACTED]');
  assert.equal(redactSecrets('aws key AKIAABCDEFGHIJKLMNOP fim'), 'aws key [REDACTED] fim');
});

test('redactSecrets: redige PAT de granularidade fina do GitHub (github_pat_...)', () => {
  assert.equal(redactSecrets('token=github_pat_11ABCDEFG0abcdefghijk_1234567890'), 'token=[REDACTED]');
});

test('redactSecrets: classe de caractere larga o suficiente para nao vazar resto de token com /, + ou = (JWT/base64-ish)', () => {
  // Token propositalmente com '/', '+' e '=' -- se a classe de caractere
  // fosse estreita demais, so um PREFIXO do token seria redigido e o resto
  // vazaria em claro no comentario publicado.
  const jwtLikeToken = 'abc123/def+456=ghi789==';
  const text = `Authorization: Bearer ${jwtLikeToken} rejeitado`;
  const redacted = redactSecrets(text);

  assert.equal(redacted, 'Authorization: [REDACTED] rejeitado');
  assert.ok(!redacted.includes(jwtLikeToken));
  // nenhum fragmento do token (nem apos os simbolos) deveria sobrar
  assert.ok(!redacted.includes('ghi789'));
});

test('redactSecrets: sk-ant e ghp_ tambem nao vazam resto de token com /, + ou =', () => {
  assert.equal(redactSecrets('key=sk-ant-api03-abc/def+ghi='), 'key=[REDACTED]');
  assert.equal(redactSecrets('token=ghp_abc123/def+456='), 'token=[REDACTED]');
});

test('redactSecrets: texto sem segredo passa intacto', () => {
  const text = 'expect(locator).toBeVisible() failed: element not found';
  assert.equal(redactSecrets(text), text);
});

test('redactSecrets: multiplos segredos na mesma mensagem, todos redigidos', () => {
  const text = 'sk-ant-aaa e tambem ghp_bbb111';
  assert.equal(redactSecrets(text), '[REDACTED] e tambem [REDACTED]');
});

// ---------------------------------------------------------------------------
// reportToPR
// ---------------------------------------------------------------------------

interface FakeComment {
  id: number;
  body: string;
  created_at: string;
  user?: { type?: string } | null;
}

function fakeOctokit(initialComments: FakeComment[]): {
  client: OctokitLikeClient;
  calls: { created: unknown[]; updated: unknown[] };
  comments: FakeComment[];
} {
  const comments = [...initialComments];
  const calls: { created: unknown[]; updated: unknown[] } = { created: [], updated: [] };
  let nextId = 1000;

  const client: OctokitLikeClient = {
    rest: {
      issues: {
        listComments: async ({ per_page, page }) => {
          const start = (page - 1) * per_page;
          const data = comments.slice(start, start + per_page);
          return { data };
        },
        createComment: async (params) => {
          // O client real do Octokit (autenticado com GITHUB_TOKEN de um
          // workflow) sempre cria comentarios como bot -- fixture reflete
          // isso pra exercitar o filtro de autor de `findLatestMarkedComment`.
          const created = { id: nextId++, body: params.body, created_at: new Date().toISOString(), user: { type: 'Bot' } };
          comments.push(created);
          calls.created.push(params);
          return { data: { id: created.id } };
        },
        updateComment: async (params) => {
          const existing = comments.find((c) => c.id === params.comment_id);
          if (existing) {
            existing.body = params.body;
          }
          calls.updated.push(params);
          return { data: { id: params.comment_id } };
        },
      },
    },
  };

  return { client, calls, comments };
}

test('reportToPR: sem octokit injetado e GITHUB_TOKEN ausente/vazio -> erro de configuracao claro, nunca um 401 opaco', async () => {
  const original = process.env.GITHUB_TOKEN;
  try {
    delete process.env.GITHUB_TOKEN;

    await assert.rejects(
      reportToPR({ owner: 'minha-org', repo: 'meu-repo', prNumber: 7, runId: '1-1', body: '## Resultado' }),
      /GITHUB_TOKEN ausente ou vazio/,
    );

    process.env.GITHUB_TOKEN = '';
    await assert.rejects(
      reportToPR({ owner: 'minha-org', repo: 'meu-repo', prNumber: 7, runId: '1-1', body: '## Resultado' }),
      /GITHUB_TOKEN ausente ou vazio/,
    );
  } finally {
    if (original === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = original;
    }
  }
});

test('reportToPR: primeira execucao (sem comentario marcado) -> cria um novo, embutindo o marcador do run atual', async () => {
  const { client, calls } = fakeOctokit([]);

  const result = await reportToPR({
    owner: 'minha-org',
    repo: 'meu-repo',
    prNumber: 7,
    runId: '123-1',
    body: '## Resultado',
    octokit: client,
  });

  assert.equal(result.action, 'created');
  assert.equal(calls.created.length, 1);
  assert.equal(calls.updated.length, 0);
  const body = (calls.created[0] as { body: string }).body;
  assert.match(body, /## Resultado/);
  assert.match(body, /<!-- agente-testes:v1 run=123-1 -->/);
  assert.ok(body.includes(MARKER_PREFIX));
});

test('reportToPR: comentario marcado ja existe -> atualiza o existente, nunca cria um segundo', async () => {
  const { client, calls, comments } = fakeOctokit([
    {
      id: 1,
      body: `corpo antigo\n\n<!-- agente-testes:v1 run=100-1 -->`,
      created_at: '2026-08-01T00:00:00.000Z',
      user: { type: 'Bot' },
    },
  ]);

  const result = await reportToPR({
    owner: 'minha-org',
    repo: 'meu-repo',
    prNumber: 7,
    runId: '200-1',
    body: '## Resultado novo',
    octokit: client,
  });

  assert.equal(result.action, 'updated');
  assert.equal(result.commentId, 1);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.updated.length, 1);
  assert.equal(comments.length, 1, 'nunca deveria criar um segundo comentario');
  assert.match(comments[0].body, /## Resultado novo/);
  assert.match(comments[0].body, /run=200-1/);
});

test('reportToPR: multiplos comentarios marcados (anomalo) -> usa o mais recente por created_at', async () => {
  const { client, calls } = fakeOctokit([
    { id: 1, body: `mais antigo\n\n<!-- agente-testes:v1 run=1-1 -->`, created_at: '2026-08-01T00:00:00.000Z', user: { type: 'Bot' } },
    { id: 2, body: `mais recente\n\n<!-- agente-testes:v1 run=2-1 -->`, created_at: '2026-08-15T00:00:00.000Z', user: { type: 'Bot' } },
    { id: 3, body: `nao marcado (comentario de humano)`, created_at: '2026-08-20T00:00:00.000Z', user: { type: 'User' } },
  ]);

  const result = await reportToPR({
    owner: 'minha-org',
    repo: 'meu-repo',
    prNumber: 7,
    runId: '300-1',
    body: '## Resultado',
    octokit: client,
  });

  assert.equal(result.action, 'updated');
  assert.equal(result.commentId, 2, 'deveria atualizar o comentario marcado mais recente, nao o mais antigo nem o nao-marcado');
  assert.equal(calls.updated.length, 1);
  assert.equal((calls.updated[0] as { comment_id: number }).comment_id, 2);
});

test('reportToPR: comentario de HUMANO contendo o texto do marcador -> ignorado, nunca sobrescrito (cria um novo em vez disso)', async () => {
  const { client, calls, comments } = fakeOctokit([
    {
      id: 1,
      body: `Cuidado, o Agente usa um marcador tipo <!-- agente-testes:v1 run=1-1 --> pra achar o proprio comentario`,
      created_at: '2026-08-01T00:00:00.000Z',
      user: { type: 'User' },
    },
  ]);

  const result = await reportToPR({
    owner: 'minha-org',
    repo: 'meu-repo',
    prNumber: 7,
    runId: '500-1',
    body: '## Resultado',
    octokit: client,
  });

  assert.equal(result.action, 'created', 'comentario de humano nunca deveria ser tratado como o marcado deste Agente');
  assert.equal(calls.created.length, 1);
  assert.equal(calls.updated.length, 0);
  assert.equal(comments.length, 2, 'comentario de humano preservado, um novo criado ao lado dele');
});

test('reportToPR: pagina todos os comentarios (nao assume que cabem numa unica pagina de 100)', async () => {
  const firstPage: FakeComment[] = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    body: `comentario nao marcado ${i}`,
    created_at: '2026-08-01T00:00:00.000Z',
  }));
  const secondPage: FakeComment[] = [
    { id: 101, body: `marcado\n\n<!-- agente-testes:v1 run=1-1 -->`, created_at: '2026-08-10T00:00:00.000Z', user: { type: 'Bot' } },
  ];

  const { client, calls } = fakeOctokit([...firstPage, ...secondPage]);

  const result = await reportToPR({
    owner: 'minha-org',
    repo: 'meu-repo',
    prNumber: 7,
    runId: '400-1',
    body: '## Resultado',
    octokit: client,
  });

  assert.equal(result.action, 'updated');
  assert.equal(result.commentId, 101, 'comentario marcado da segunda pagina deveria ter sido encontrado');
  assert.equal(calls.updated.length, 1);
});
