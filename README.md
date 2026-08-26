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

## Observacoes

- Autenticacao e sessao (`express-session`, `MemoryStore`, secret fixo no
  codigo) sao deliberadamente simples -- esta app e uma fixture de teste,
  nao um produto. Nao usar como base para autenticacao real.
- Todos os dados sao perdidos a cada reinicio do processo.
- Escopo desta story cobre apenas os 3 fluxos acima. Logout, redirecionamento
  automatico de usuario ja autenticado e validacao explicita de campos
  vazios foram deferidos -- ver `deferred-work.md`.
