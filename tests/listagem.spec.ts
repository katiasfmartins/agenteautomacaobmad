import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Area (areas.yaml): listagem. Cobre FR-4/FR-5 (Story 1.3) para o fluxo de
// listagem da aplicacao-exemplo (Story 1.1). A tag `@listagem` e o nome do
// describe permitem que o Agente-Testes (Epic 2+) selecione este arquivo
// pela area correspondente.
test.describe('listagem', { tag: '@listagem' }, () => {
  test('acesso sem sessao redireciona para /login', async ({ page }) => {
    await page.goto('/listagem');

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('#lista-itens')).toHaveCount(0);
  });

  test('acesso apos login exibe usuario logado e itens da listagem', async ({ page }) => {
    // Usuario proprio deste teste, cadastrado via /cadastro e depois
    // autenticado via /login, para nao depender do usuario semente nem
    // colidir com outros testes na mesma instancia em memoria.
    const username = `listagem-${randomUUID()}`;
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
    await expect(page.locator('#lista-itens li')).toHaveCount(4);
  });
});
