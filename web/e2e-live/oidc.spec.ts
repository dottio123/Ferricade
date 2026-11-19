import { expect, test } from '@playwright/test'

const API = '/admin/api/v1'
const OIDC_SETTINGS = `${API}/settings/oidc`

test.use({ storageState: 'test-results-live/owner-state.json' })

test('OIDC creates an owner through Dex and refuses unmapped groups', async ({ page }) => {
  const me = await page.request.get(`${API}/auth/me`)
  expect(me.ok()).toBeTruthy()
  const { csrf_token: csrf } = await me.json()
  const update = await page.request.patch(OIDC_SETTINGS, {
    headers: { 'X-CSRF-Token': csrf, Origin: 'http://localhost:21220' },
    data: {
      enabled: true,
      display_name: 'Dex',
      issuer: 'http://dex:5556/dex',
      client_id: 'ferricade',
      client_secret: 'ferricade-e2e-secret',
      owner_groups: ['authors'],
      admin_groups: [],
      jit_enabled: true,
    },
  })
  expect(update.status(), await update.text()).toBe(200)
  const logout = await page.request.post(`${API}/auth/logout`, {
    headers: { 'X-CSRF-Token': csrf, Origin: 'http://localhost:21220' },
  })
  expect(logout.status(), await logout.text()).toBe(204)
  await page.goto('/sign-in')
  await page.getByRole('link', { name: 'Sign in with Dex' }).click()
  await expect(page).toHaveURL(/localhost:21220\//)
  const signedIn = await page.request.get(`${API}/auth/me`)
  expect(signedIn.status(), await signedIn.text()).toBe(200)
  const who = await signedIn.json()
  expect(who.user.display_name).toBe('Kilgore Trout')
  expect(who.user.role).toBe('owner')
  expect(who.mfa_passed).toBe(true)

  const refusedMapping = await page.request.patch(OIDC_SETTINGS, {
    headers: { 'X-CSRF-Token': who.csrf_token, Origin: 'http://localhost:21220' },
    data: { owner_groups: ['nobody'], admin_groups: ['nobody'] },
  })
  expect(refusedMapping.status(), await refusedMapping.text()).toBe(200)
  const logoutAgain = await page.request.post(`${API}/auth/logout`, {
    headers: { 'X-CSRF-Token': who.csrf_token, Origin: 'http://localhost:21220' },
  })
  expect(logoutAgain.status(), await logoutAgain.text()).toBe(204)
  await page.goto('/sign-in')
  await page.getByRole('link', { name: 'Sign in with Dex' }).click()
  await expect(page).toHaveURL(/\/sign-in\?sso_error=not_allowed$/)
  await expect(page.getByRole('alert')).toHaveText(
    'Your account at Dex is not in a group that may use Ferricade.',
  )
})
