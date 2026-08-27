/**
 * Estagio de Selecao de Testes (FR-3).
 *
 * Deterministico -- nao chama o modelo. Casa cada area identificada pela
 * Analise de Area com a tag `{ tag: '@<area>' }` de cada `tests/*.spec.ts`
 * (convencao estabelecida na Story 1.3, ver `tests/login.spec.ts` etc.).
 *
 * Uma area sem nenhum teste com a tag correspondente entra em
 * `unmappedAreas` -- nunca e omitida, e nada roda silenciosamente para
 * essa area.
 *
 * Inverso (AD-1, emendado no Spec Change Log de 2026-08-27): um
 * `tests/*.spec.ts` sem NENHUMA tag `@area` e erro de configuracao --
 * nunca e silenciosamente ignorado. Isso interrompe toda a Selecao de
 * Testes (lanca excecao, nao devolve resultado parcial), depois de logar
 * quais arquivos estao sem tag.
 *
 * Roda via type-stripping nativo do Node -- sintaxe TS aqui precisa
 * continuar "erasable".
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SelectTestsParams {
  areas: string[];
  testsDir: string;
}

export interface SelectTestsResult {
  selectedTests: string[];
  unmappedAreas: string[];
}

const TAG_PATTERN = /tag:\s*(['"])@([a-z0-9-]+)\1/g;

function extractTags(content: string): Set<string> {
  const tags = new Set<string>();
  let match: RegExpExecArray | null;

  // Regex com flag global mantem estado em `lastIndex` -- reset explicito
  // evita comportamento surpreendente caso a mesma regex seja reutilizada.
  TAG_PATTERN.lastIndex = 0;

  while ((match = TAG_PATTERN.exec(content)) !== null) {
    tags.add(match[2]);
  }

  return tags;
}

export function selectTests(params: SelectTestsParams): SelectTestsResult {
  const { areas, testsDir } = params;

  const specFiles = readdirSync(testsDir).filter((fileName) => fileName.endsWith('.spec.ts'));

  const fileTagsByPath = new Map<string, Set<string>>();
  for (const fileName of specFiles) {
    const filePath = join(testsDir, fileName);
    const content = readFileSync(filePath, 'utf-8');
    fileTagsByPath.set(filePath, extractTags(content));
  }

  const untaggedFiles: string[] = [];
  for (const [filePath, tags] of fileTagsByPath) {
    if (tags.size === 0) {
      untaggedFiles.push(filePath);
    }
  }

  if (untaggedFiles.length > 0) {
    console.log(
      JSON.stringify({
        event: 'test_selection_untagged_spec_files',
        untaggedFiles,
        detail: 'spec sem nenhuma tag @area e erro de configuracao (AD-1) -- Selecao de Testes interrompida',
      }),
    );
    throw new Error(
      `selectTests: ${untaggedFiles.length} arquivo(s) *.spec.ts sem nenhuma tag @area (erro de configuracao, AD-1): ${untaggedFiles.join(', ')}`,
    );
  }

  const selectedTests: string[] = [];
  const unmappedAreas: string[] = [];

  for (const area of areas) {
    let matched = false;

    for (const [filePath, tags] of fileTagsByPath) {
      if (tags.has(area)) {
        matched = true;
        if (!selectedTests.includes(filePath)) {
          selectedTests.push(filePath);
        }
      }
    }

    if (!matched) {
      unmappedAreas.push(area);
    }
  }

  return { selectedTests, unmappedAreas };
}
