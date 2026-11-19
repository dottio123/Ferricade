import AxeBuilder from '@axe-core/playwright'
import { expect, test as base } from './support/test'

const test = base.extend<{ refused: void }>({
  refused: [
    async ({ page }, use) => {
      const refused: string[] = []
      page.on('response', (res) => {
        if (res.status() === 403) refused.push(`${res.request().method()} ${res.url()}`)
      })
      await use()
      expect(refused, '403 responses').toEqual([])
    },
    { auto: true },
  ],
})

test.describe('Settings → Deployment', () => {
  test('owner can configure profile, set and remove secrets, and download scripts', async ({
    page,
  }) => {
    // 1. Navigate from Settings index
    await page.goto('/settings')
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    const deployCard = page.getByRole('link', { name: /Deployment/i })
    await expect(deployCard).toBeVisible()
    await deployCard.click()

    await expect(page).toHaveURL(/\/settings\/deployment/)
    await expect(page.getByRole('heading', { level: 1, name: 'Deployment' })).toBeVisible()
    await expect(
      page.getByText(
        'Connects RustDesk to this server: ID server, relay server, public key and API server (the client configuration on the Settings page)',
      ),
    ).toBeVisible()
    const approveRow = page.locator('[data-slot="setting-row-approve-mode"]')
    await expect(approveRow.getByText('How incoming connections are accepted')).toBeVisible()
    await approveRow.getByRole('switch', { name: /Include in script/i }).click()
    await approveRow.getByRole('combobox').click()
    await expect(page.getByRole('option', { name: 'Password or click' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByText('Y enables', { exact: false })).toHaveCount(0)
    await expect(page.getByText('use-temporary-password', { exact: false })).toHaveCount(0)

    // 2. Change client version and a setting
    const versionChoice = page.getByRole('combobox', { name: 'Client version' })
    await expect(versionChoice).toContainText('Latest release')
    await expect(page.getByLabel('Windows SHA-256')).toHaveCount(0)
    await versionChoice.click()
    await page.getByRole('option', { name: 'Specific version' }).click()
    const versionInput = page.getByRole('textbox', { name: 'Specific version' })
    await versionInput.fill('1.5.1')
    await expect(
      page.getByText(
        'You have unsaved changes. Save them first: the script is built from the saved settings.',
      ),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Windows (.ps1)' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Linux (.sh)' })).toBeDisabled()

    // Find setting row for direct IP access or LAN discovery
    const directSettingRow = page.locator('[data-slot="setting-row-direct-server"]')
    await expect(directSettingRow).toBeVisible()
    const includeSwitch = directSettingRow.getByRole('switch', { name: /Include in script/i })
    await includeSwitch.click()
    const valueSwitch = directSettingRow.getByRole('switch', {
      name: /Direct IP connections value/i,
    })
    await valueSwitch.click()

    // Save changes
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(
      page.locator('[data-slot="toast-title"]', { hasText: 'Deployment profile saved' }),
    ).toBeVisible()
    await expect(
      page.getByText(
        'You have unsaved changes. Save them first: the script is built from the saved settings.',
      ),
    ).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Windows (.ps1)' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Linux (.sh)' })).toBeEnabled()

    // Reload and verify persistence
    await page.reload()
    await expect(page.getByRole('combobox', { name: 'Client version' })).toContainText(
      'Specific version',
    )
    await expect(page.getByRole('textbox', { name: 'Specific version' })).toHaveValue('1.5.1')
    const reloadedDirectRow = page.locator('[data-slot="setting-row-direct-server"]')
    await expect(
      reloadedDirectRow.getByRole('switch', { name: /Include in script/i }),
    ).toBeChecked()
    await expect(
      reloadedDirectRow.getByRole('switch', { name: /Direct IP connections value/i }),
    ).toBeChecked()

    // 3. Password warning: toggle include_password when no password is set
    const pwIncludeSwitch = page.getByRole('switch', { name: /Include fleet password in script/i })
    await pwIncludeSwitch.click()
    await expect(
      page.getByText(
        'You have unsaved changes. Save them first: the script is built from the saved settings.',
      ),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Windows (.ps1)' })).toBeDisabled()
    await expect(page.getByText("Leaves the device's password unchanged")).toBeVisible()
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(
      page.getByText(
        'No fleet password is set: the script removes the permanent password from every device it runs on.',
      ),
    ).toBeVisible()
    await expect(
      page.locator('[data-slot="toast-title"]', { hasText: 'Deployment profile saved' }),
    ).toBeVisible()

    // 4. Set fleet password with mismatch then valid, ensuring unsaved edits are not saved
    await versionInput.fill('1.5.9-unsaved')

    await page.getByRole('button', { name: 'Set fleet password' }).click()
    const pwDialog = page.getByRole('dialog', { name: /Set fleet password/i })
    await expect(pwDialog).toBeVisible()

    await pwDialog.getByLabel(/^Fleet password/i).fill('FleetPass123')
    await pwDialog.getByLabel(/Confirm password/i).fill('Mismatch123')
    await pwDialog.getByRole('button', { name: 'Save password' }).click()
    await expect(pwDialog.getByText(/Passwords do not match/i)).toBeVisible()

    await pwDialog.getByLabel(/Confirm password/i).fill('FleetPass123')
    await pwDialog.getByRole('button', { name: 'Save password' }).click()

    await expect(pwDialog).not.toBeVisible()
    await expect(
      page.locator('[data-slot="toast-title"]', { hasText: /Password set/i }),
    ).toBeVisible()
    await expect(page.getByText(/Set on .* by .*/i).first()).toBeVisible()

    // Unsaved edit is still in the field before reload
    await expect(versionInput).toHaveValue('1.5.9-unsaved')

    // Reload and verify the unsaved version edit was not saved to backend
    await page.reload()
    await expect(page.getByRole('textbox', { name: 'Specific version' })).toHaveValue('1.5.1')
    await expect(page.getByText(/Set on .* by .*/i).first()).toBeVisible()

    // Warning is gone now that password is set
    await expect(
      page.getByText(
        'No fleet password is set: the script removes the permanent password from every device it runs on.',
      ),
    ).toHaveCount(0)

    // 5. Remove fleet password
    await page.getByRole('button', { name: 'Remove fleet password' }).click()
    await expect(
      page.locator('[data-slot="toast-title"]', { hasText: /Password removed/i }),
    ).toBeVisible()
    await expect(page.getByText('Not set').first()).toBeVisible()

    // Warning appears again since include is still on
    await expect(
      page.getByText(
        'No fleet password is set: the script removes the permanent password from every device it runs on.',
      ),
    ).toBeVisible()

    // Unlock PIN warning follows the same include and stored-state rules.
    const pinWarning =
      'No unlock PIN is set: the script removes the settings unlock PIN from every device it runs on.'
    const pinIncludeSwitch = page.getByRole('switch', { name: 'Include unlock PIN in script' })
    await pinIncludeSwitch.click()
    await expect(
      page.getByText(
        'You have unsaved changes. Save them first: the script is built from the saved settings.',
      ),
    ).toBeVisible()
    await expect(page.getByText(pinWarning)).toHaveCount(0)
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText(pinWarning)).toBeVisible()
    await pinIncludeSwitch.click()
    await expect(page.getByText(pinWarning)).toBeVisible()
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText(pinWarning)).toHaveCount(0)
    await pinIncludeSwitch.click()
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText(pinWarning)).toBeVisible()
    await page.getByRole('button', { name: 'Set unlock PIN' }).click()
    const pinDialog = page.getByRole('dialog', { name: 'Set unlock PIN' })
    await pinDialog.getByLabel('Unlock PIN').fill('SecurityPIN-42')
    await pinDialog.getByLabel('Confirm PIN').fill('SecurityPIN-42')
    await pinDialog.getByRole('button', { name: 'Save PIN' }).click()
    await expect(pinDialog).not.toBeVisible()
    await expect(page.getByText(pinWarning)).toHaveCount(0)

    // 6. Downloads
    const [winDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Windows (.ps1)' }).click(),
    ])
    expect(winDownload.suggestedFilename()).toBe('ferricade-deploy.ps1')

    const [linuxDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Linux (.sh)' }).click(),
    ])
    expect(linuxDownload.suggestedFilename()).toBe('ferricade-deploy.sh')

    // macOS disabled
    await expect(page.getByRole('button', { name: 'macOS: coming later' })).toBeDisabled()
  })

  test('Enter in a profile field submits the profile exactly once', async ({ page }) => {
    const puts: string[] = []
    page.on('request', (req) => {
      if (
        req.method() === 'PUT' &&
        new URL(req.url()).pathname === '/admin/api/v1/deployment/profile'
      )
        puts.push(req.url())
    })

    await page.goto('/settings/deployment')
    await page.getByRole('combobox', { name: 'Client version' }).click()
    await page.getByRole('option', { name: 'Specific version' }).click()
    const versionInput = page.getByRole('textbox', { name: 'Specific version' })
    await versionInput.fill('1.5.1')
    await versionInput.press('Enter')

    await expect(
      page.locator('[data-slot="toast-title"]', { hasText: 'Deployment profile saved' }),
    ).toBeVisible()
    // Give a duplicate submit time to show up before counting.
    await page.waitForTimeout(500)
    expect(puts).toHaveLength(1)
  })
  test('admin role sees read-only settings with working downloads', async ({ page }) => {
    await page.goto('/settings/deployment?mock-role=admin')
    await expect(page.getByRole('heading', { level: 1, name: 'Deployment' })).toBeVisible()

    // Read-only indicator
    await expect(page.getByText(/Only owners can edit deployment settings/i)).toBeVisible()

    // Inputs and secret buttons disabled / absent
    await expect(page.getByRole('combobox', { name: 'Client version' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Set fleet password/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Remove fleet password/i })).toHaveCount(0)

    // Downloads are available
    const [winDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Windows (.ps1)' }).click(),
    ])
    expect(winDownload.suggestedFilename()).toBe('ferricade-deploy.ps1')
  })

  test('user role cannot access settings or deployment and is redirected to /', async ({
    page,
  }) => {
    // /settings redirects to /
    await page.goto('/settings?mock-role=user')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/')

    // /settings/deployment redirects to /
    await page.goto('/settings/deployment?mock-role=user')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/')
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`zero critical/serious a11y violations in ${theme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto('/settings/deployment')
      await page.waitForLoadState('domcontentloaded')
      await expect(page.getByRole('heading', { level: 1, name: 'Deployment' })).toBeVisible()
      await page.evaluate((t) => {
        document.documentElement.setAttribute('data-theme', t)
      }, theme)

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()

      const severe = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      )
      expect(severe).toEqual([])
    })
  }
})
