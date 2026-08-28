import { defineConfig } from '@playwright/test';

// Configuracao minima para a Suite Piloto (Story 1.3). O Test Runner (Story
// 2.3) exige evidencia completa por teste, passe ou falhe (FR-7 a FR-11):
// screenshot/video/trace sempre ligados, e um reporter `json` (alem do
// `html` ja existente) para que tempo por step vire dado consumivel, nao
// so HTML. O mecanismo de "selecao vazia" (AD-3) vive em `agent/test-runner.ts`,
// nao aqui.
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    // A aplicacao-exemplo (Story 1.1) nao sobe automaticamente: por AD-11,
    // subir o servidor antes dos testes e responsabilidade do workflow YAML
    // do agente-testes (Epic 2), nunca do proprio Playwright/test-runner.
    // Localmente, rode `npm start` num terminal antes de `npm test`.
    baseURL: 'http://localhost:3000',
    // Evidencia completa sempre, passe ou falhe (FR-7 a FR-9) -- screenshot
    // final de cada teste, video completo, trace nativo (Network/Console/
    // timeline por step ja incluidos no trace viewer, ver Design Notes da
    // spec 2.3).
    screenshot: 'on',
    video: 'on',
    trace: 'on',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
