import { expect, test } from './support/test'

const ALLOWED_ERRORS =
  /status of (400|401|409) .*\/setup\/(owner|server|complete)|status of 401 .*\/admin\/api\/v1\/auth\/me/

test.use({ allowConsoleErrors: [ALLOWED_ERRORS] })

const DEMO_PUBLIC_KEY = 'OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw='

test.describe('First-run setup wizard flows', () => {
  test('walks through the 5-step wizard to completion', async ({ page }) => {
    await page.goto('/first-run?mock-setup=incomplete')
    await expect(page.getByRole('heading', { level: 1, name: 'First-run setup' })).toBeVisible()

    // Step 1: Token
    await expect(page.getByRole('heading', { level: 2, name: 'Paste setup token' })).toBeVisible()
    await page.getByLabel('Setup token').fill('mock-setup-token')
    await page.getByRole('button', { name: 'Continue' }).click()

    // Step 2: Owner
    await expect(
      page.getByRole('heading', { level: 2, name: 'Create owner account' }),
    ).toBeVisible()
    await page.getByLabel('Username').fill('superowner')
    await page.getByLabel('Password').fill('correct horse battery')
    await page.getByRole('button', { name: 'Create owner and continue' }).click()

    // Step 3: TOTP
    await expect(
      page.getByRole('heading', { level: 2, name: 'Set up two-factor authentication' }),
    ).toBeVisible()
    await expect(page.getByLabel('Secret key (if you cannot scan)')).toBeVisible()
    await page.getByLabel('Verification code').fill('123456')
    await page.getByRole('button', { name: 'Verify and continue' }).click()

    // Step 4: Server
    await expect(
      page.getByRole('heading', { level: 2, name: 'Configure server profile' }),
    ).toBeVisible()
    await page.getByLabel('ID server host').fill('rd.example.com')
    await page.getByLabel('Relay server host').fill('rd.example.com')
    await page.getByLabel('Public key').fill(DEMO_PUBLIC_KEY)
    await page.getByRole('button', { name: 'Save and check server' }).click()

    // Server check results visible
    await expect(page.getByText('ID Server (port 21116)')).toBeVisible()
    await expect(page.getByText('Relay Server (port 21117)')).toBeVisible()
    await expect(page.getByText('HBBS Online Query')).toBeVisible()
    await expect(page.getByText('Passing').first()).toBeVisible()

    await page.getByRole('button', { name: 'Continue' }).click()

    // Step 5: Summary review
    await expect(
      page.getByRole('heading', { level: 2, name: 'Review and complete setup' }),
    ).toBeVisible()
    await expect(page.getByText('superowner')).toBeVisible()
    await expect(page.getByText('rd.example.com').first()).toBeVisible()

    // Complete setup
    await page.getByRole('button', { name: 'Finish setup' }).click()

    // Step 5: Client configuration displayed
    await expect(page.getByRole('heading', { level: 2, name: 'Setup complete' })).toBeVisible()
    await expect(page.getByLabel('Server configuration string')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in to the command center' })).toBeVisible()

    // Navigate to sign-in
    await page.getByRole('button', { name: 'Sign in to the command center' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
  })

  test('wrong setup token triggers 401 and returns to step 1 with calm error', async ({ page }) => {
    await page.goto('/first-run?mock-setup=incomplete')
    await expect(page.getByRole('heading', { level: 1, name: 'First-run setup' })).toBeVisible()

    // Step 1: enter invalid token
    await page.getByLabel('Setup token').fill('invalid-token')
    await page.getByRole('button', { name: 'Continue' }).click()

    // Step 2: attempt to submit owner
    await expect(
      page.getByRole('heading', { level: 2, name: 'Create owner account' }),
    ).toBeVisible()
    await page.getByLabel('Username').fill('admin')
    await page.getByLabel('Password').fill('correct horse battery')
    await page.getByRole('button', { name: 'Create owner and continue' }).click()

    // Returned to Step 1 with calm error
    await expect(page.getByRole('heading', { level: 2, name: 'Paste setup token' })).toBeVisible()
    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toHaveText(
      'That setup token is wrong or has expired. Copy it again from the Ferricade log.',
    )
  })

  test('validates password rules live and displays server weak_password error', async ({
    page,
  }) => {
    await page.goto('/first-run?mock-setup=incomplete')
    await page.getByLabel('Setup token').fill('mock-setup-token')
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(
      page.getByRole('heading', { level: 2, name: 'Create owner account' }),
    ).toBeVisible()
    await page.getByLabel('Username').fill('owner')

    // Short password: live rule shows 5/12
    await page.getByLabel('Password').fill('short')
    await expect(page.getByText('At least 12 characters (5/12)')).toBeVisible()

    // Password matching username: rule not satisfied
    await page.getByLabel('Password').fill('owner')
    await expect(page.getByText('At least 12 characters (5/12)')).toBeVisible()

    // Common password: 12 characters, but server rejects with weak_password
    await page.getByLabel('Password').fill('password1234')
    await expect(page.getByText('At least 12 characters (12/12)')).toBeVisible()
    await page.getByRole('button', { name: 'Create owner and continue' }).click()

    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toHaveText('that password is too common')
  })

  test('server check failure displays warning and allows continuing anyway', async ({ page }) => {
    await page.goto('/first-run?mock-setup=incomplete')
    await page.getByLabel('Setup token').fill('mock-setup-token')
    await page.getByRole('button', { name: 'Continue' }).click()

    await page.getByLabel('Username').fill('owner')
    await page.getByLabel('Password').fill('correct horse battery')
    await page.getByRole('button', { name: 'Create owner and continue' }).click()

    await page.getByLabel('Verification code').fill('123456')
    await page.getByRole('button', { name: 'Verify and continue' }).click()

    // Step 4: use down host to trigger failed check
    await page.getByLabel('ID server host').fill('down.example.com')
    await page.getByLabel('Relay server host').fill('rd.example.com')
    await page.getByLabel('Public key').fill(DEMO_PUBLIC_KEY)
    await page.getByRole('button', { name: 'Save and check server' }).click()

    // Failed indicator and warning visible
    await expect(page.getByText('Failed', { exact: true })).toBeVisible()
    await expect(page.getByText(/Some reachability checks failed/i)).toBeVisible()

    // Continue anyway button is present and works
    await page.getByRole('button', { name: 'Continue anyway' }).click()
    await expect(
      page.getByRole('heading', { level: 2, name: 'Review and complete setup' }),
    ).toBeVisible()
  })

  test('invalid public key shows inline error and preserves step', async ({ page }) => {
    await page.goto('/first-run?mock-setup=incomplete')
    await page.getByLabel('Setup token').fill('mock-setup-token')
    await page.getByRole('button', { name: 'Continue' }).click()

    await page.getByLabel('Username').fill('owner')
    await page.getByLabel('Password').fill('correct horse battery')
    await page.getByRole('button', { name: 'Create owner and continue' }).click()

    await page.getByLabel('Verification code').fill('123456')
    await page.getByRole('button', { name: 'Verify and continue' }).click()

    // Step 4: invalid key
    await page.getByLabel('ID server host').fill('rd.example.com')
    await page.getByLabel('Relay server host').fill('rd.example.com')
    await page.getByLabel('Public key').fill('not-a-valid-key')
    await page.getByRole('button', { name: 'Save and check server' }).click()

    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toHaveText('Public key must be base64 of 32 bytes.')
    await expect(
      page.getByRole('heading', { level: 2, name: 'Configure server profile' }),
    ).toBeVisible()
  })

  test('Back button in summary returns to server step with inputs preserved', async ({ page }) => {
    await page.goto('/first-run?mock-setup=incomplete')
    await page.getByLabel('Setup token').fill('mock-setup-token')
    await page.getByRole('button', { name: 'Continue' }).click()

    await page.getByLabel('Username').fill('owner')
    await page.getByLabel('Password').fill('correct horse battery')
    await page.getByRole('button', { name: 'Create owner and continue' }).click()

    await page.getByLabel('Verification code').fill('123456')
    await page.getByRole('button', { name: 'Verify and continue' }).click()

    // Step 4: fill server profile
    await page.getByLabel('ID server host').fill('custom-id.example.com')
    await page.getByLabel('Relay server host').fill('custom-relay.example.com')
    await page.getByLabel('Public key').fill(DEMO_PUBLIC_KEY)
    await page.getByRole('button', { name: 'Save and check server' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()

    // In summary
    await expect(
      page.getByRole('heading', { level: 2, name: 'Review and complete setup' }),
    ).toBeVisible()

    // Click Back
    await page.getByRole('button', { name: 'Back' }).click()

    // Back in server step with inputs preserved
    await expect(
      page.getByRole('heading', { level: 2, name: 'Configure server profile' }),
    ).toBeVisible()
    await expect(page.getByLabel('ID server host')).toHaveValue('custom-id.example.com')
    await expect(page.getByLabel('Relay server host')).toHaveValue('custom-relay.example.com')
    await expect(page.getByLabel('Public key')).toHaveValue(DEMO_PUBLIC_KEY)
  })
})
