import { expect, test } from './support/test'

const ALLOWED_ERRORS =
  /status of (401|423) .*\/admin\/api\/v1\/auth\/(me|login)|status of (400|423) .*\/admin\/api\/v1\/auth\/totp/

test.use({ allowConsoleErrors: [ALLOWED_ERRORS] })

test.describe('Sign-in flows', () => {
  test('optional two-factor account without TOTP signs in without enrollment', async ({ page }) => {
    await page.goto('/sign-in?mock-session=optional')
    await page.getByLabel('Username').fill('alex')
    await page.getByLabel('Password').fill('correct horse battery')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    await expect(
      page.getByRole('heading', { level: 1, name: 'Set up two-factor authentication' }),
    ).toHaveCount(0)
  })

  test('successful sign-in with username, password, and TOTP', async ({ page }) => {
    await page.goto('/sign-in?mock-session=signed-out')
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()

    await page.getByLabel('Username').fill('alex')
    await page.getByLabel('Password').fill('correct horse battery')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByRole('heading', { level: 1, name: 'Two-factor code' })).toBeVisible()
    await page.getByLabel('Code').fill('123456')
    await page.getByRole('button', { name: 'Verify' }).click()

    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    await expect(page.getByText('Alex Rivera', { exact: true })).toBeVisible()
  })

  test('wrong password shows calm error message', async ({ page }) => {
    await page.goto('/sign-in?mock-session=signed-out')
    await page.getByLabel('Username').fill('alex')
    await page.getByLabel('Password').fill('wrong-password')
    await page.getByRole('button', { name: 'Sign in' }).click()

    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toHaveText("That username and password don't match.")
  })

  test('five wrong passwords answers locked', async ({ page }) => {
    await page.goto('/sign-in?mock-session=signed-out')

    for (let i = 0; i < 5; i++) {
      await page.getByLabel('Username').fill('alex')
      await page.getByLabel('Password').fill(`wrong-${i}`)
      await page.getByRole('button', { name: 'Sign in' }).click()
      await expect(page.getByRole('alert')).toBeVisible()
    }

    await expect(page.getByRole('alert')).toHaveText(
      'Too many attempts. Try again in a few minutes.',
    )
  })

  test('wrong TOTP code shows calm error message', async ({ page }) => {
    await page.goto('/sign-in?mock-session=signed-out')
    await page.getByLabel('Username').fill('alex')
    await page.getByLabel('Password').fill('correct horse battery')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByRole('heading', { level: 1, name: 'Two-factor code' })).toBeVisible()
    await page.getByLabel('Code').fill('999999')
    await page.getByRole('button', { name: 'Verify' }).click()

    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toHaveText("That code didn't match. Check your app and try again.")
  })

  test('reused TOTP code (000000) answers code_already_used', async ({ page }) => {
    await page.goto('/sign-in?mock-session=signed-out')
    await page.getByLabel('Username').fill('alex')
    await page.getByLabel('Password').fill('correct horse battery')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByRole('heading', { level: 1, name: 'Two-factor code' })).toBeVisible()
    await page.getByLabel('Code').fill('000000')
    await page.getByRole('button', { name: 'Verify' }).click()

    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toHaveText('That code was just used. Wait for the next one.')
  })
})
