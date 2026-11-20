import { expect, mockReady, test } from './support/test'

test.use({
  allowConsoleErrors: [/status of (401 .*\/auth\/me|409 .*\/users\/|400 .*\/settings\/oidc)/],
})

test('OIDC link uses the safe next path and disappears when off', async ({ page }) => {
  await page.goto('/sign-in?mock-session=signed-out&mock-oidc=on&next=%2Fdevices')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Ferricade' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Sign in with Authentik' })).toHaveAttribute(
    'href',
    '/admin/api/v1/auth/oidc/start?next=%2Fdevices',
  )
  await page.goto('/sign-in?mock-session=signed-out')
  await expect(page.getByRole('link', { name: /Sign in with/ })).toHaveCount(0)
})

test('OIDC link remains visible after a protected page redirects a signed-out user', async ({
  page,
}) => {
  await page.goto('/devices?mock-session=signed-out&mock-oidc=on')
  await expect(page).toHaveURL(/\/sign-in/)
  await expect(page.getByRole('link', { name: 'Sign in with Authentik' })).toBeVisible()
})

const errors = [
  ['not_allowed', 'Your account at Authentik is not in a group that may use Ferricade.'],
  [
    'no_account',
    'There is no Ferricade account for you, and new accounts are not created automatically. Ask an owner.',
  ],
  ['disabled', 'Your Ferricade account is disabled. Ask an owner.'],
  [
    'provider_error',
    'Signing in with Authentik did not work. Try again, or sign in with your password.',
  ],
  ['expired', 'Your sign-in took too long or was started again. Try again.'],
  ['rate_limited', 'Too many sign-in attempts. Wait a minute and try again.'],
  [
    'unexpected',
    'Signing in with Authentik did not work. Try again, or sign in with your password.',
  ],
] as const
for (const [code, message] of errors) {
  test(`shows OIDC error ${code}`, async ({ page }) => {
    await page.goto(`/sign-in?mock-session=signed-out&mock-oidc=on&sso_error=${code}`)
    await expect(page.getByRole('alert')).toHaveText(message)
  })
}

test('owner configures and tests sign-in, admin cannot open it', async ({ page }) => {
  await page.goto('/settings')
  await page.getByRole('link', { name: /Sign-In Configure provider/i }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Sign-In' })).toBeVisible()
  await expect(page.getByText('A secret is saved')).toHaveCount(0)
  await page.getByLabel('Button name').fill('Dex')
  await page.getByLabel('Issuer URL').fill('https://example.com')
  await page.getByLabel('Client ID').fill('ferricade')
  await page.getByLabel('Client secret').fill('secret-value')
  await page.getByLabel('Owner groups').fill('authors')
  await page.getByLabel('Owner groups').press('Enter')
  await page.getByLabel('Sign in with OIDC').click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('A secret is saved')).toBeVisible()
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText('Connection succeeded.')).toBeVisible()
  await expect(page.getByText('Groups scope: supported')).toBeVisible()
  await page.getByRole('button', { name: 'Copy' }).click()
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()
  await page.goto('/settings?mock-role=admin')
  await expect(page.getByRole('link', { name: /Sign-in Configure provider/ })).toHaveCount(0)
  await page.goto('/settings/sign-in?mock-role=admin')
  await expect(page.getByText('Only owners can manage sign-in settings.')).toBeVisible()
})

test('SSO badge and Unlink confirmation', async ({ page }) => {
  await page.goto('/settings')
  await mockReady(page)
  await page.evaluate(() => window.__ferricadeMock!.setUserSSO('sam', true))
  await page.getByRole('link', { name: /Users Manage/ }).click()
  const row = page.getByRole('row', { name: /sam/i })
  await expect(row.locator('[data-slot="badge"]', { hasText: 'SSO' })).toBeVisible()
  await row.getByRole('button', { name: 'More actions for sam' }).click()
  await page.getByRole('menuitem', { name: 'Unlink SSO' }).click()
  await expect(
    page.getByText(
      'Sam Okafor will no longer sign in through the provider and will be signed out.',
    ),
  ).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Unlink SSO' }).click()
  await expect(row.locator('[data-slot="badge"]', { hasText: 'SSO' })).toHaveCount(0)
})

test('Unlink SSO refuses to lock out a user without a password', async ({ page }) => {
  await page.goto('/settings')
  await mockReady(page)
  await page.evaluate(() => window.__ferricadeMock!.setUserSSO('sam', false))
  await page.getByRole('link', { name: /Users Manage/ }).click()
  const row = page.getByRole('row', { name: /sam/i })
  await row.getByRole('button', { name: 'More actions for sam' }).click()
  await page.getByRole('menuitem', { name: 'Unlink SSO' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Unlink SSO' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    'This user has no password, so unlinking would lock them out.',
  )
})
