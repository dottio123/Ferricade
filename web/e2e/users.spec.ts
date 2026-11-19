import { expect, mockReady, test } from './support/test'

const ALLOWED_ERRORS = /status of (400|409)/
test.use({ allowConsoleErrors: [ALLOWED_ERRORS] })

test.describe('Users management (Owner only)', () => {
  test('loads users page with heading and user table', async ({ page }) => {
    await page.goto('/settings/users')
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible()

    // Assert initial users from mock fixture in table
    const table = page.getByRole('table')
    await expect(table.getByText('alex', { exact: true })).toBeVisible()
    await expect(table.getByText('sam', { exact: true })).toBeVisible()
  })

  test('creates a new user with password validation', async ({ page }) => {
    await page.goto('/settings/users')

    await page.getByRole('button', { name: 'New user' }).click()
    await expect(page.getByRole('heading', { name: 'Create new user' })).toBeVisible()

    const submitBtn = page.getByRole('button', { name: 'Create user' })

    // Fill username
    await page.getByLabel('Username').fill('newadmin')

    // Try a password that is too short
    await page.getByLabel(/^Password/).fill('short')
    await expect(submitBtn).toBeDisabled()
    await expect(page.getByText('At least 12 characters')).toBeVisible()

    // Try password equal to username
    await page.getByLabel(/^Password/).fill('newadmin')
    await expect(submitBtn).toBeDisabled()
    await expect(page.getByText('Not the username, in any capitalisation')).toBeVisible()

    // Now fill a valid compliant password
    await page.getByLabel(/^Password/).fill('validsecretpass123')
    await expect(submitBtn).toBeEnabled()

    // Submit
    await submitBtn.click()

    // Check modal closes and new user appears in table
    await expect(page.getByRole('table').getByText('newadmin', { exact: true })).toBeVisible()
  })

  test('edits an existing user', async ({ page }) => {
    await page.goto('/settings/users')

    // Edit user 'sam'
    const row = page.getByRole('row', { name: /sam/i })
    await row.getByRole('button', { name: 'Edit user sam' }).click()

    await expect(page.getByRole('heading', { name: /Edit user.*sam/i })).toBeVisible()

    await page.getByLabel('Display name').fill('Samuel Okafor Updated')
    await page.getByRole('button', { name: 'Save changes' }).click()

    // Assert update appears in table
    await expect(page.getByRole('table').getByText('Samuel Okafor Updated')).toBeVisible()
  })

  test('resets TOTP for a user', async ({ page }) => {
    await page.goto('/settings/users')

    // Reset TOTP on 'sam' via More actions menu
    const row = page.getByRole('row', { name: /sam/i })
    await row.getByRole('button', { name: 'More actions for sam' }).click()
    await page.getByRole('menuitem', { name: 'Reset 2FA' }).click()

    await expect(
      page.getByRole('heading', { name: 'Reset two-factor authentication' }),
    ).toBeVisible()
    await expect(page.getByText(/Reset two-factor authentication for.*sam/i)).toBeVisible()
    await expect(
      page.getByText(/They will set up a new authenticator at their next sign-in/i),
    ).toBeVisible()

    await page.getByRole('button', { name: 'Reset 2FA' }).click()

    // Toast appears
    await expect(
      page.locator('[data-slot="toast-title"]', { hasText: /TOTP reset for sam/i }),
    ).toBeVisible()
  })

  test('resets the helpdesk password: a common one is refused, a valid one succeeds', async ({
    page,
  }) => {
    await page.goto('/settings/users')

    const alexRow = page.getByRole('row', { name: /alex/i })
    await alexRow.getByRole('button', { name: 'More actions for alex' }).click()
    await expect(page.getByRole('menuitem', { name: 'Reset password' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    const row = page.getByRole('row', { name: /helpdesk/i })
    await row.getByRole('button', { name: 'More actions for helpdesk' }).click()
    await page.getByRole('menuitem', { name: 'Reset password' }).click()
    await expect(page.getByRole('heading', { name: /Reset password for.*helpdesk/ })).toBeVisible()

    const save = page.getByRole('button', { name: 'Save' })
    await expect(save).toBeDisabled()

    await page.getByLabel('New password', { exact: true }).fill('password1234')
    await page.getByLabel('Confirm new password').fill('password1234')
    await expect(save).toBeEnabled()
    await save.click()
    await expect(page.getByText('that password is too common')).toBeVisible()
    await expect(page.getByRole('heading', { name: /Reset password for.*helpdesk/ })).toBeVisible()

    await page.getByLabel('New password', { exact: true }).fill('a-fine-new-password')
    await page.getByLabel('Confirm new password').fill('a-fine-new-password')
    await save.click()

    await expect(
      page.locator('[data-slot="toast-title"]', { hasText: 'Password reset for helpdesk' }),
    ).toBeVisible()
    await expect(page.getByRole('heading', { name: /Reset password for.*helpdesk/ })).toHaveCount(0)
  })

  test('prevents demoting or disabling the last active owner', async ({ page }) => {
    await page.goto('/settings/users')

    // Edit user 'alex' (who is currently the only owner)
    const row = page.getByRole('row', { name: /alex/i })
    await row.getByRole('button', { name: 'Edit user alex' }).click()

    await expect(page.getByRole('heading', { name: /Edit user.*alex/i })).toBeVisible()

    // Attempt to change role to User via Select dropdown (triggers self-demotion confirmation)
    await page.locator('#user-edit-role').click()
    await page.getByRole('option', { name: 'User' }).click()
    await expect(page.getByText(/Warning: modifying your own account/i)).toBeVisible()
    await expect(
      page.getByText(
        /Removing your owner role will immediately demote your account to user privileges/i,
      ),
    ).toBeVisible()

    // Attempt to change role to Admin via Select dropdown
    await page.locator('#user-edit-role').click()
    await page.getByRole('option', { name: 'Admin' }).click()

    // Notice self-action warning appears
    await expect(page.getByText(/Warning: modifying your own account/i)).toBeVisible()
    await expect(
      page.getByText(
        /Removing your owner role will immediately demote your account to admin privileges/i,
      ),
    ).toBeVisible()

    const confirmCheckbox = page.getByLabel('I understand and wish to proceed')
    await expect(confirmCheckbox).toBeVisible()
    await confirmCheckbox.check()

    // Try saving
    await page.getByRole('button', { name: 'Save changes' }).click()

    // Calm 409 error message should be displayed
    await expect(
      page.getByText('You cannot demote or disable the last active owner.'),
    ).toBeVisible()
  })

  test('more actions menu is keyboard-accessible and opens each dialog', async ({ page }) => {
    await page.goto('/settings')
    await mockReady(page)
    await page.evaluate(() => window.__ferricadeMock!.setUserSSO('sam', true))
    await page.getByRole('link', { name: /Users/ }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible()

    const samRow = page.getByRole('row', { name: /sam/i })
    const samTrigger = samRow.getByRole('button', { name: 'More actions for sam' })
    await expect(samTrigger).toBeVisible()

    // Open menu via keyboard and trigger Reset 2FA
    await samTrigger.focus()
    await page.keyboard.press('Enter')
    const resetTotpItem = page.getByRole('menuitem', { name: 'Reset 2FA' })
    await expect(resetTotpItem).toBeVisible()
    await expect(resetTotpItem).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(
      page.getByRole('heading', { name: 'Reset two-factor authentication' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()

    // Re-open menu via keyboard, arrow down to Reset password
    await samTrigger.focus()
    await page.keyboard.press('Enter')
    await expect(resetTotpItem).toBeFocused()
    await page.keyboard.press('ArrowDown')
    const resetPasswordItem = page.getByRole('menuitem', { name: 'Reset password' })
    await expect(resetPasswordItem).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: /Reset password for.*sam/i })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()

    // Re-open menu via keyboard, arrow down twice to Unlink SSO
    await samTrigger.focus()
    await page.keyboard.press('Enter')
    await expect(resetTotpItem).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(resetPasswordItem).toBeFocused()
    await page.keyboard.press('ArrowDown')
    const unlinkItem = page.getByRole('menuitem', { name: 'Unlink SSO' })
    await expect(unlinkItem).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: 'Unlink SSO' })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  for (const width of [1440, 1280, 768, 390, 320]) {
    test(`no horizontal scroll at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 })
      await page.goto('/settings/users')
      await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible()

      if (width < 768) {
        const cards = page.locator('[data-slot="users-mobile-cards"]')
        await expect(cards).toBeVisible()
        await expect(cards.getByText('alex', { exact: true })).toBeVisible()
        await expect(page.getByRole('table')).toBeHidden()
      } else {
        const table = page.getByRole('table')
        await expect(table).toBeVisible()
        await expect(table.getByText('alex', { exact: true })).toBeVisible()
        const tableOverflow = await table
          .locator('..')
          .evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
        expect(tableOverflow.scrollWidth).toBeLessThanOrEqual(tableOverflow.clientWidth)
      }

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }))
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth)
    })
  }

  for (const width of [768, 1023]) {
    for (const hasTouch of [false, true]) {
      test(`table inner scroller fits at ${width}px (${hasTouch ? 'coarse' : 'fine'} pointer)`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          viewport: { width, height: 844 },
          hasTouch,
        })
        const page = await context.newPage()
        await page.goto('/settings/users')
        await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible()
        const table = page.getByRole('table')
        await expect(table).toBeVisible()
        await expect(table.getByText('alex', { exact: true })).toBeVisible()

        const inner = await table
          .locator('..')
          .evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
        expect(inner.scrollWidth).toBeLessThanOrEqual(inner.clientWidth)
        await context.close()
      })
    }
  }

  test('more actions menu items are at least 44px tall on coarse pointer', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    })
    const page = await context.newPage()
    await page.goto('/settings')
    await mockReady(page)
    await page.evaluate(() => window.__ferricadeMock!.setUserSSO('sam', true))
    await page.getByRole('link', { name: /Users/ }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible()

    const samCard = page.locator('[data-slot="user-card"]', { hasText: 'sam' })
    await samCard.getByRole('button', { name: 'More actions for sam' }).click()

    for (const name of ['Reset 2FA', 'Reset password', 'Unlink SSO']) {
      const item = page.getByRole('menuitem', { name })
      await expect(item).toBeVisible()
      await expect
        .poll(async () => (await item.boundingBox())?.height ?? 0, {
          message: `${name} height`,
        })
        .toBeGreaterThanOrEqual(44)
    }
    await context.close()
  })
})
