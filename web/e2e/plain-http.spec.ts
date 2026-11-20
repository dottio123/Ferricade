import { AUTH_ME_401, expect, test } from './support/test'

test.use({ allowConsoleErrors: [AUTH_ME_401] })

const NOTICE =
  'This console is served over plain HTTP. Sign-ins and session cookies are not encrypted on the network.'

test.describe('Plain HTTP indicator', () => {
  test('is hidden when plain_http is false', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Plain HTTP connection' })).toHaveCount(0)

    await page.goto('/sign-in?mock-session=signed-out')
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
    await expect(page.getByText(NOTICE)).toHaveCount(0)
  })

  test('shows quiet indicator in console and helper note on sign-in when ?mock-http=plain', async ({
    page,
  }) => {
    await page.goto('/?mock-http=plain')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    const indicator = page.getByRole('button', { name: 'Plain HTTP connection' })
    await expect(indicator).toBeVisible()
    await expect(indicator).toHaveText('HTTP')

    await indicator.focus()
    await expect(page.getByText(NOTICE)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByText(NOTICE)).toBeHidden()

    await indicator.click()
    await expect(page.getByText(NOTICE)).toBeVisible()

    await page.goto('/sign-in?mock-session=signed-out&mock-http=plain')
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
    await expect(page.getByText(NOTICE)).toBeVisible()
  })
})

test.describe('Plain HTTP indicator on mobile viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('tapping the indicator on mobile opens and closes the explanation', async ({ page }) => {
    await page.goto('/?mock-http=plain')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    const indicator = page.getByRole('button', { name: 'Plain HTTP connection' })
    await expect(indicator).toBeVisible()
    await indicator.tap()
    await expect(page.getByText(NOTICE)).toBeVisible()
  })
})
