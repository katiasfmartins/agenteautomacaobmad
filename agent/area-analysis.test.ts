import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeAreas, parseAreasYaml, AREA_DESCONHECIDA } from './area-analysis.ts';
import type { CallModelParams, CallModelResult } from './llm-client.ts';

function makeAreasFile(ids: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'area-analysis-test-'));
  const filePath = join(dir, 'areas.yaml');
  const body = ['# comentario de topo', ...ids.map((id) => `- ${id}`)].join('\n');
  writeFileSync(filePath, body, 'utf-8');
  return filePath;
}

function fakeCallModel(areas: unknown[]): (params: CallModelParams) => Promise<CallModelResult> {
  return async () => ({
    toolInput: { areas },
    inputTokens: 10,
    outputTokens: 5,
  });
}

/** Captura chamadas de console.log durante `fn` e restaura o original depois. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (line: unknown) => {
    lines.push(String(line));
  };

  try {
    const result = await fn();
    return { result, logs: lines };
  } finally {
    console.log = original;
  }
}

test('parseAreasYaml: extrai IDs kebab-case de lista flat, ignorando comentarios e linhas vazias', () => {
  const raw = [
    '# Taxonomia canonica de Area (AD-1)',
    '# sem aninhamento nem metadados no MVP.',
    '',
    '- login',
    '- cadastro',
    '- listagem',
    '',
  ].join('\n');

  assert.deepEqual(parseAreasYaml(raw), ['login', 'cadastro', 'listagem']);
});

test('analyzeAreas: PR so de documentacao -> modelo devolve areas vazia -> permanece vazia (nao vira area-desconhecida)', async () => {
  const areasFilePath = makeAreasFile(['login', 'cadastro', 'listagem']);

  const { result } = await captureLogs(() =>
    analyzeAreas({
      diff: 'diff --git a/README.md b/README.md\n+algo',
      areasFilePath,
      runId: 'run-doc',
      callModel: fakeCallModel([]),
    }),
  );

  assert.deepEqual(result.areas, []);
  rmSync(areasFilePath, { force: true });
});

test('analyzeAreas: PR toca um unico fluxo conhecido -> areas: ["login"]', async () => {
  const areasFilePath = makeAreasFile(['login', 'cadastro', 'listagem']);

  const { result } = await captureLogs(() =>
    analyzeAreas({
      diff: 'diff --git a/public/login.html b/public/login.html\n+algo',
      areasFilePath,
      runId: 'run-login',
      callModel: fakeCallModel(['login']),
    }),
  );

  assert.deepEqual(result.areas, ['login']);
  rmSync(areasFilePath, { force: true });
});

test('analyzeAreas: modelo reporta area-desconhecida diretamente -> mantida (nunca fica vazia silenciosamente) e logada para auditoria', async () => {
  const areasFilePath = makeAreasFile(['login', 'cadastro', 'listagem']);

  const { result, logs } = await captureLogs(() =>
    analyzeAreas({
      diff: 'diff --git a/README.md b/README.md\n+algo',
      areasFilePath,
      runId: 'run-unknown',
      callModel: fakeCallModel([AREA_DESCONHECIDA]),
    }),
  );

  assert.deepEqual(result.areas, [AREA_DESCONHECIDA]);
  const auditLog = logs.map((l) => JSON.parse(l)).find((l) => l.event === 'area_desconhecida_reportada');
  assert.ok(auditLog, 'esperava log de auditoria para area-desconhecida');
  assert.equal(auditLog.runId, 'run-unknown');
  rmSync(areasFilePath, { force: true });
});

test('analyzeAreas: modelo alucina ID inexistente ("pagamento") -> substituido por area-desconhecida e logado como anomalia (nunca fuzzy-match)', async () => {
  const areasFilePath = makeAreasFile(['login', 'cadastro', 'listagem']);

  const { result, logs } = await captureLogs(() =>
    analyzeAreas({
      diff: 'diff sintetico',
      areasFilePath,
      runId: 'run-hallucination',
      callModel: fakeCallModel(['pagamento']),
    }),
  );

  assert.deepEqual(result.areas, [AREA_DESCONHECIDA]);
  const anomalyLog = logs.map((l) => JSON.parse(l)).find((l) => l.event === 'area_id_invalido_substituido');
  assert.ok(anomalyLog, 'esperava log de anomalia para ID invalido');
  assert.equal(anomalyLog.invalidAreaId, 'pagamento');
  assert.equal(anomalyLog.replacement, AREA_DESCONHECIDA);
  rmSync(areasFilePath, { force: true });
});

test('analyzeAreas: mistura de areas validas, invalida e area-desconhecida -> dedup e cada invalida vira o sentinela', async () => {
  const areasFilePath = makeAreasFile(['login', 'cadastro', 'listagem']);

  const { result } = await captureLogs(() =>
    analyzeAreas({
      diff: 'diff sintetico',
      areasFilePath,
      runId: 'run-mix',
      callModel: fakeCallModel(['login', 'pagamento', AREA_DESCONHECIDA, 'estoque']),
    }),
  );

  // 'pagamento' e 'estoque' nao existem -> ambos viram area-desconhecida;
  // AREA_DESCONHECIDA explicito tambem se junta -> resultado dedupado.
  assert.deepEqual(result.areas, ['login', AREA_DESCONHECIDA]);
  rmSync(areasFilePath, { force: true });
});

test('analyzeAreas: chama callModel com schemaName "area-analysis" e runId propagado', async () => {
  const areasFilePath = makeAreasFile(['login']);

  let capturedParams: CallModelParams | undefined;
  const callModel = async (params: CallModelParams): Promise<CallModelResult> => {
    capturedParams = params;
    return { toolInput: { areas: [] }, inputTokens: 0, outputTokens: 0 };
  };

  await captureLogs(() =>
    analyzeAreas({
      diff: 'diff sintetico',
      areasFilePath,
      runId: 'run-schema-check',
      callModel,
    }),
  );

  assert.equal(capturedParams?.schemaName, 'area-analysis');
  assert.equal(capturedParams?.runId, 'run-schema-check');
  assert.match(capturedParams?.systemPrompt ?? '', /login/);
  rmSync(areasFilePath, { force: true });
});
