/**
 * Cliente unico do Claude (AD-2).
 *
 * Toda chamada ao modelo, de qualquer estagio do Agente, passa por
 * `callModel`. Isso garante que:
 * - o modelo usado e sempre o mesmo (`claude-sonnet-5`);
 * - a saida e sempre estruturada via tool-use (nunca texto livre parseado
 *   na mao) -- o schema (`input_schema`) e carregado de um arquivo JSON
 *   versionado em `agent/schemas/`;
 * - toda chamada e logada com `{runId, schemaName, schemaVersion,
 *   inputTokens, outputTokens}` (NFR3/NFR4).
 *
 * A API key so pode vir de `ANTHROPIC_API_KEY` (GitHub Actions Secret) --
 * nunca lida ou passada por outro mecanismo. O client real (`new
 * Anthropic()`) le essa variavel de ambiente sozinho; nunca a repassamos
 * explicitamente aqui.
 *
 * O client e injetavel por parametro (com o client real como default) para
 * que `callModel` seja testavel sem chamada de rede -- ver Design Notes da
 * spec 2.2.
 *
 * Roda via type-stripping nativo do Node (`node agent/*.ts`), sem
 * `tsc`/`tsx`/`ts-node`: sintaxe TS aqui precisa continuar "erasable".
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 2048;

export interface AnthropicToolDefinition {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicLikeContentBlock {
  type: string;
  name?: string;
  input?: unknown;
}

export interface AnthropicLikeUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
}

export interface AnthropicLikeMessage {
  content: AnthropicLikeContentBlock[];
  usage?: AnthropicLikeUsage;
}

export interface AnthropicLikeClient {
  messages: {
    create: (params: Record<string, unknown>) => Promise<AnthropicLikeMessage>;
  };
}

export interface CallModelParams {
  systemPrompt: string;
  userPrompt: string;
  schemaPath: string;
  schemaName: string;
  runId: string;
  client?: AnthropicLikeClient;
}

export interface CallModelResult {
  toolInput: Record<string, unknown>;
  inputTokens: number;
  outputTokens: number;
}

function loadToolSchema(schemaPath: string): { schemaVersion: string; tool: AnthropicToolDefinition } {
  const raw = readFileSync(schemaPath, 'utf-8');
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== 'object' || !parsed.schemaVersion || !parsed.tool) {
    throw new Error(
      `llm-client: schema em "${schemaPath}" invalido -- esperado { schemaVersion, tool } com tool.name e tool.input_schema`,
    );
  }

  return { schemaVersion: parsed.schemaVersion, tool: parsed.tool };
}

function createDefaultClient(): AnthropicLikeClient {
  // Le ANTHROPIC_API_KEY do ambiente sozinho (comportamento padrao do SDK) --
  // nunca lemos/repassamos a chave explicitamente neste modulo.
  return new Anthropic() as unknown as AnthropicLikeClient;
}

export async function callModel(params: CallModelParams): Promise<CallModelResult> {
  const { systemPrompt, userPrompt, schemaPath, schemaName, runId } = params;
  const client = params.client ?? createDefaultClient();

  const { schemaVersion, tool } = loadToolSchema(schemaPath);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  });

  const toolUseBlock = response.content.find(
    (block): block is AnthropicLikeContentBlock & { input: Record<string, unknown> } =>
      block.type === 'tool_use' && block.name === tool.name,
  );

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;

  console.log(
    JSON.stringify({
      event: 'llm_call',
      runId,
      schemaName,
      schemaVersion,
      inputTokens,
      outputTokens,
    }),
  );

  if (!toolUseBlock) {
    throw new Error(
      `llm-client: resposta do modelo nao contem um bloco tool_use para a tool "${tool.name}" (schema "${schemaName}"/${schemaVersion})`,
    );
  }

  return {
    toolInput: (toolUseBlock.input ?? {}) as Record<string, unknown>,
    inputTokens,
    outputTokens,
  };
}
