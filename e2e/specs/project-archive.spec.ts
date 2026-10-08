import { test, expect } from '../fixtures/client';
import { flushClientDb } from '../helpers/app';

test('completed projects move to Archive and return when reopened', async ({ page }) => {
  const sidebar = page.getByRole('complementary');
  const archiveButton = sidebar.getByRole('button', { name: 'Archived projects', exact: true });
  await expect(archiveButton).toHaveCount(0);

  await sidebar.getByRole('button', { name: 'New folder or project' }).click();
  await page.getByRole('button', { name: 'New Parallel Project' }).click();
  const detail = page.getByTestId('task-detail');
  await detail.getByPlaceholder('Title').fill('Archive test project');
  await detail.getByPlaceholder('Title').press('Enter');
  const project = sidebar.getByRole('link', { name: 'Archive test project', exact: true });
  await expect(project).toBeVisible();
  const href = await project.getAttribute('href');

  await detail.getByRole('button', { name: 'Mark complete', exact: true }).click();
  await expect(project).toHaveCount(0);
  await expect(archiveButton).toBeVisible();
  await archiveButton.click();
  const archive = sidebar.getByRole('region', { name: 'Archived projects' });
  await expect(archive.getByRole('link', { name: 'Archive test project' })).toBeVisible();
  await expect(project).toHaveAttribute('href', href!);
  await sidebar.getByRole('button', { name: 'Collapse Archive' }).click();
  await expect(project).toHaveCount(0);

  await flushClientDb(page);
  await page.reload();
  await expect(archiveButton).toBeVisible();
  await expect(project).toHaveCount(0);
  await archiveButton.click();
  await project.click();
  // Open the project inspector from its title if it was closed by the reload.
  await page.getByRole('heading', { name: 'Archive test project', exact: true }).click();
  await detail.getByRole('button', { name: 'Mark incomplete', exact: true }).click();
  await expect(archiveButton).toHaveCount(0);
  await expect(archive).toHaveCount(0);
  await expect(project).toBeVisible();
});
