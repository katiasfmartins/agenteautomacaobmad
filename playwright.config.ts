import { defineConfig } from '@playwright/test';

// Configuracao minima para a Suite Piloto (Story 1.3). Captura completa de
// evidencia (screenshot/video/trace sempre ligados, FR-7 a FR-9) e o
// mecanismo de "selecao vazia" (AD-3) sao responsabilidade do Epic 2, nao
// desta story -- aqui so o essencial para o framework rodar e gerar saida
// na estrutura esperada pelo AD-3.
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    // A aplicacao-exemplo (Story 1.1) nao sobe automaticamente: por AD-11,
    // subir o servidor antes dos testes e responsabilidade do workflow YAML
    // do agente-testes (Epic 2), nunca do proprio Playwright/test-runner.
    // Localmente, rode `npm start` num terminal antes de `npm test`.
    baseURL: 'http://localhost:3000',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
