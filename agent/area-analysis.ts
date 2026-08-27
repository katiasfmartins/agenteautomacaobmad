/**
 * Estagio de Analise de Area (AD-1).
 *
 * Recebe o diff de uma PR como string (nao busca sozinho -- ver Design
 * Notes da spec 2.2) e pede ao modelo, via `llm-client.ts`, quais areas
 * conhecidas (`areas.yaml`) o diff afeta.
 *
 * Cada ID devolvido pelo modelo e validado contra o conteudo real de
 * `areas.yaml`:
 * - ID conhecido -> mantido como esta;
 * - sentinela reservado `area-desconhecida` -> mantido, e logado para
 *   auditoria (o modelo o usa quando parte do diff nao corresponde a
 *   nenhuma area conhecida);
 * - qualquer outro ID (nao existe em `areas.yaml`) -> substituido pelo
 *   sentinela `area-desconhecida` e logado como anomalia (alucinacao do
 *   modelo). Nunca aproximado ("fuzzy match") ao ID mais parecido, nunca
 *   descartado silenciosamente.
 *
 * Lista vazia (`areas: []`) e um resultado valido e distinto de conter
 * `area-desconhecida` -- acontece quando o diff nao toca nenhuma area
 * conhecida nem nada fora do mapeamento (ex.: PR so de documentacao).
 *
 * Roda via type-stripping nativo do Node -- sintaxe TS aqui precisa
 * continuar "erasable".
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callModel as defaultCallModel, type CallModelParams, type CallModelResult } from './llm-client.ts';

export const AREA_DESCONHECIDA = 'area-desconhecida';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA_PATH = join(CURRENT_DIR, 'schemas', 'area-analysis.v1.json');
const SCHEMA_NAME = 'area-analysis';

export type CallModelFn = (params: CallModelParams) => Promise<CallModelResult>;

export interface AnalyzeAreasParams {
  diff: string;
  areasFilePath: string;
  runId: string;
  callModel?: CallModelFn;
}

export interface AnalyzeAreasResult {
  areas: string[];
}

/**
 * Parser local e minimo do formato flat kebab-case de `areas.yaml`
 * (comentarios `#` + lista `- id`, sem aninhamento nem metadados -- AD-1).
 * Formato fixo por decisao de projeto; nao vale a pena trazer `js-yaml`
 * so para isso (ver Design Notes).
 */
export function parseAreasYaml(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((id) => id.length > 0);
}

function buildSystemPrompt(knownAreaIds: string[]): string {
  return [
    'Voce e o estagio de Analise de Area do Agente de Testes.',
    'Dado o diff de uma Pull Request, identifique quais das areas conhecidas abaixo o diff afeta.',
    '',
    `Areas conhecidas (unicos IDs validos): ${knownAreaIds.join(', ')}.`,
    '',
    'Regras obrigatorias:',
    `- Use APENAS IDs da lista acima, ou o sentinela reservado "${AREA_DESCONHECIDA}".`,
    '- Nunca invente um ID que nao esteja na lista.',
    `- Se parte do diff nao corresponder a nenhuma area conhecida (ex.: documentacao, CI, configuracao, arquivos fora do mapeamento), inclua "${AREA_DESCONHECIDA}" na lista.`,
    '- Se o diff nao afeta nenhuma area conhecida e nao ha nada fora do mapeamento (ex.: diff vazio), devolva uma lista vazia.',
    '- Nao repita o mesmo ID mais de uma vez na lista.',
  ].join('\n');
}

function buildUserPrompt(diff: string): string {
  return `Diff da Pull Request:\n\n${diff}`;
}

export async function analyzeAreas(params: AnalyzeAreasParams): Promise<AnalyzeAreasResult> {
  const { diff, areasFilePath, runId } = params;

  // Diff vazio (ex.: base===head, ou nenhuma mudanca de conteudo) nunca
  // corresponde a nenhuma area nem a area-desconhecida -- devolver []
  // direto evita uma chamada de API desnecessaria (custo, NFR4).
  if (diff.trim().length === 0) {
    console.log(
      JSON.stringify({
        event: 'area_analysis_skipped_empty_diff',
        runId,
        detail: 'diff vazio -- areas: [] sem chamar o modelo',
      }),
    );
    return { areas: [] };
  }

  const callModel = params.callModel ?? defaultCallModel;

  const areasYamlRaw = readFileSync(areasFilePath, 'utf-8');
  const knownAreaIds = parseAreasYaml(areasYamlRaw);
  const knownAreaIdSet = new Set(knownAreaIds);

  const { toolInput } = await callModel({
    systemPrompt: buildSystemPrompt(knownAreaIds),
    userPrompt: buildUserPrompt(diff),
    schemaPath: DEFAULT_SCHEMA_PATH,
    schemaName: SCHEMA_NAME,
    runId,
  });

  const rawAreas = Array.isArray(toolInput.areas) ? (toolInput.areas as unknown[]) : [];

  const finalAreas: string[] = [];
  const seen = new Set<string>();

  for (const rawValue of rawAreas) {
    const rawId = typeof rawValue === 'string' ? rawValue : String(rawValue);

    let resolvedId: string;

    if (rawId === AREA_DESCONHECIDA) {
      resolvedId = AREA_DESCONHECIDA;
      console.log(
        JSON.stringify({
          event: 'area_desconhecida_reportada',
          runId,
          detail: 'modelo reportou parte do diff fora de qualquer area conhecida',
        }),
      );
    } else if (knownAreaIdSet.has(rawId)) {
      resolvedId = rawId;
    } else {
      resolvedId = AREA_DESCONHECIDA;
      console.log(
        JSON.stringify({
          event: 'area_id_invalido_substituido',
          runId,
          invalidAreaId: rawId,
          replacement: AREA_DESCONHECIDA,
          detail: 'ID retornado pelo modelo nao existe em areas.yaml -- nunca aproximado, sempre sentinela',
        }),
      );
    }

    if (!seen.has(resolvedId)) {
      seen.add(resolvedId);
      finalAreas.push(resolvedId);
    }
  }

  return { areas: finalAreas };
}
