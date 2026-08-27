# agenteautomacaobmad

Aplicacao-exemplo minima em Node.js + Express, usada como alvo real de testes
pela Suite Piloto Playwright (Stories 1.2/1.3) e pelo pipeline do Agente
(Epic 2+). Serve HTML/CSS/JS puro, sem framework frontend e sem banco de
dados real -- todos os dados (usuarios cadastrados e itens da listagem)
vivem em memoria e **resetam a cada restart** do servidor.

## Fluxos

- **Login** (`/login`) -- autenticacao contra o array de usuarios em memoria.
- **Cadastro** (`/cadastro`) -- cria um novo usuario em memoria (username deve
  ser inedito; a comparacao e exata e case-sensitive).
- **Listagem** (`/listagem`) -- exige sessao valida (redireciona para
  `/login` caso contrario); mostra uma lista fixa de itens-semente, sem
  relacao com os usuarios cadastrados.

## Como rodar

```bash
npm install
npm start
```

O servidor sobe em `http://localhost:3000` (ou na porta definida pela
variavel de ambiente `PORT`), sem exigir configuracao adicional.

## Suite Piloto (Playwright)

Cobertura minima de testes ponta-a-ponta, um arquivo por fluxo central da
aplicacao-exemplo, cada um tagueado com o ID de area correspondente em
`areas.yaml` (usado pelo Agente-Testes, Epic 2+, para selecionar o que
rodar):

| Arquivo | Fluxo | Area (`areas.yaml`) |
|---|---|---|
| `tests/login.spec.ts` | Login (valido e invalido) | `login` |
| `tests/cadastro.spec.ts` | Cadastro (valido e duplicado) | `cadastro` |
| `tests/listagem.spec.ts` | Listagem (guarda de sessao e exibicao pos-login) | `listagem` |

### Como rodar

Em um terminal, suba a aplicacao:

```bash
npm start
```

Em outro terminal, com o servidor no ar, rode a suite:

```bash
npm test
```

O relatorio HTML e gerado em `playwright-report/index.html`. Para listar os
testes e conferir as tags sem executa-los: `npx playwright test --list`.

## Agente de Testes (Epic 2+)

Pipeline que roda no workflow `.github/workflows/agente-testes.yml` a cada
Pull Request para `main`: analisa o diff da PR via Claude (Analise de Area)
e casa o resultado com as tags `@area` da Suite Piloto acima (Selecao de
Testes), determinando um subconjunto dirigido de testes a rodar.

Requer o secret `ANTHROPIC_API_KEY` configurado no repositorio (GitHub
Actions Secret) -- e a unica forma aceita de fornecer a chave; sem ele, o
step "Run orchestrator" do workflow falha ao chamar o modelo.

| Modulo | Responsabilidade |
|---|---|
| `agent/llm-client.ts` | Cliente unico do Claude -- tool-use com schema versionado (`agent/schemas/`), client injetavel, log de tokens/schema por chamada |
| `agent/area-analysis.ts` | Analisa o diff via LLM e valida cada ID de area retornado contra `areas.yaml` real |
| `agent/test-selection.ts` | Casa areas identificadas com a tag `@area` de cada `tests/*.spec.ts` (deterministico, sem chamada ao modelo) |
| `agent/orchestrator.ts` | Ponto de entrada: obtem o diff da PR (`git diff base...head`) e encadeia os dois estagios acima |

Testes unitarios (`node:test`, sem rede/API real -- usam dependencia
injetada) rodam com `npm run test:unit`, tanto localmente quanto como um
step do workflow antes de "Run orchestrator".

## Observacoes

- Autenticacao e sessao (`express-session`, `MemoryStore`, secret fixo no
  codigo) sao deliberadamente simples -- esta app e uma fixture de teste,
  nao um produto. Nao usar como base para autenticacao real.
- Todos os dados sao perdidos a cada reinicio do processo.
- Escopo desta story cobre apenas os 3 fluxos acima. Logout, redirecionamento
  automatico de usuario ja autenticado e validacao explicita de campos
  vazios foram deferidos -- ver `deferred-work.md`.
