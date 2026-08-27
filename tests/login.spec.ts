import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Area (areas.yaml): login. Cobre FR-4/FR-5 (Story 1.3) para o fluxo de
// autenticacao da aplicacao-exemplo (Story 1.1). A tag `@login` e o nome do
// describe permitem que o Agente-Testes (Epic 2+) selecione este arquivo
// pela area correspondente.
test.describe('login', { tag: '@login' }, () => {
  test('login valido navega para /listagem e exibe o usuario logado', async ({ page }) => {
    // Cadastra um usuario proprio deste teste (username unico via
    // randomUUID) para nao colidir com o usuario semente (ana/123456) nem
    // com outros testes rodando na mesma instancia em memoria.
    const username = `login-valido-${randomUUID()}`;
    const password = 'senha-teste-123';

    await page.goto('/cadastro');
    await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    await page.locator('#submit').click();
    await expect(page).toHaveURL(/\/login\?cadastro=1$/);

    await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    await page.locator('#submit').click();

    await expect(page).toHaveURL(/\/listagem$/);
    await expect(page.locator('#usuario-logado')).toHaveText(username);
  });

  test('login invalido exibe #erro-login e permanece em /login', async ({ page }) => {
    const username = `login-invalido-${randomUUID()}`;

    await page.goto('/login');
    await page.locator('#username').fill(username);
    await page.locator('#password').fill('senha-errada-qualquer');
    await page.locator('#submit').click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('#erro-login')).not.toBeEmpty();
  });
});
