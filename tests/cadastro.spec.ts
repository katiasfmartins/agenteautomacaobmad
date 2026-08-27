import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Area (areas.yaml): cadastro. Cobre FR-4/FR-5 (Story 1.3) para o fluxo de
// cadastro da aplicacao-exemplo (Story 1.1). A tag `@cadastro` e o nome do
// describe permitem que o Agente-Testes (Epic 2+) selecione este arquivo
// pela area correspondente.
test.describe('cadastro', { tag: '@cadastro' }, () => {
  test('cadastro com username inedito redireciona para /login?cadastro=1', async ({ page }) => {
    const username = `cadastro-novo-${randomUUID()}`;

    await page.goto('/cadastro');
    await page.locator('#username').fill(username);
    await page.locator('#password').fill('senha-teste-123');
    await page.locator('#submit').click();

    await expect(page).toHaveURL(/\/login\?cadastro=1$/);
    await expect(page.locator('#sucesso-login')).toBeVisible();
    await expect(page.locator('#sucesso-login')).not.toBeEmpty();
  });

  test('cadastro duplicado exibe #erro-cadastro sem redirecionar', async ({ page }) => {
    // Username gerado uma vez e reaproveitado no segundo cadastro para
    // forcar a duplicidade.
    const username = `cadastro-dup-${randomUUID()}`;

    await page.goto('/cadastro');
    await page.locator('#username').fill(username);
    await page.locator('#password').fill('senha-teste-123');
    await page.locator('#submit').click();
    await expect(page).toHaveURL(/\/login\?cadastro=1$/);

    await page.goto('/cadastro');
    await page.locator('#username').fill(username);
    await page.locator('#password').fill('outra-senha-456');
    await page.locator('#submit').click();

    await expect(page).toHaveURL(/\/cadastro$/);
    await expect(page.locator('#erro-cadastro')).not.toBeEmpty();
  });
});
