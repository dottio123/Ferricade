import { expect, test } from './support/test'

test('owner changes sign-in duration and it remains after reload', async ({ page }) => {
  await page.goto('/settings')
  await page.getByRole('link', { name: /Sign-In Configure provider/ }).click()
  const duration = page.getByRole('combobox', { name: 'Sign-in duration' })
  await expect(duration).toHaveText('Until the browser closes')

  await duration.click()
  await page.getByRole('option', { name: '7 days' }).click()
  await page.getByRole('button', { name: 'Save duration' }).click()
  await expect(page.getByText('Sign-in duration saved', { exact: true })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Sign-in duration' })).toHaveText('7 days')
})
