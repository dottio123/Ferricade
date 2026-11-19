import AxeBuilder from '@axe-core/playwright'
import { expect, test } from './support/test'

function queueCard(page: import('@playwright/test').Page, hostname: string) {
  return page.locator('[data-device-id]').filter({ hasText: hostname })
}

test.describe('Groups and automatic sorting', () => {
  test('owner adds, previews, rejects a duplicate, and removes a rule', async ({
    page,
    allowConsoleErrors,
  }) => {
    allowConsoleErrors.push(
      /status of 409 \(Conflict\) \(https?:\/\/[^/]+\/admin\/api\/v1\/groups\/[^/]+\/rules\)$/,
    )
    await page.goto('/groups')
    await expect(page.getByRole('heading', { level: 1, name: 'Groups' })).toBeVisible()
    await page.getByRole('button', { name: 'Auto-sort rules for Office' }).click()

    const field = page.getByRole('textbox', { name: 'Add pattern for Office' })
    await field.fill('frontdesk-*')
    await expect(page.getByText(/Matches \d+ devices? \(\d+ pending\)/)).toBeVisible()
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByText('frontdesk-*', { exact: true })).toBeVisible()

    await field.fill('w-*-it-*')
    await expect(page.getByText(/Matches \d+ devices? \(\d+ pending\)/)).toBeVisible()
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('This pattern already exists in this group.')
    await expect(field).toHaveAttribute('aria-invalid', 'true')

    await page.getByRole('button', { name: 'Remove pattern frontdesk-*' }).click()
    await expect(page.getByText('frontdesk-*', { exact: true })).toHaveCount(0)
  })

  test('single approval places a matching pending device in its one matching group', async ({
    page,
  }) => {
    await page.goto('/groups')
    await page.getByRole('button', { name: 'Auto-sort rules for Office' }).click()
    const field = page.getByRole('textbox', { name: 'Add pattern for Office' })
    await field.fill('*')
    await expect(page.getByText(/Matches \d+ devices? \(\d+ pending\)/)).toBeVisible()
    await page.getByRole('button', { name: 'Add', exact: true }).click()

    await page.getByRole('link', { name: 'Command Center' }).click()
    await page.getByRole('link', { name: 'View approval queue' }).click()
    const card = page.locator('[data-device-id]').filter({ hasNotText: 'w-sf-it-1' }).first()
    await expect(card).toBeVisible()
    const deviceName = (await card.innerText()).split('\n').find((line) => line.trim())!
    await card.getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByRole('dialog', { name: 'Resolve Group Conflict' })).toHaveCount(0)
    await expect(page.getByText('Device approved', { exact: true })).toBeVisible()

    await page.getByRole('link', { name: 'Devices' }).click()
    await page.getByPlaceholder('Search ID, alias, host, user…').fill(deviceName)
    await expect(page.getByRole('row').filter({ hasText: deviceName })).toContainText('Office')
  })

  test('single conflicting approval opens resolution and moves the device to a chosen group', async ({
    page,
  }) => {
    await page.goto('/devices/queue')
    const conflictCard = queueCard(page, 'w-sf-it-1')
    await expect(conflictCard).toBeVisible()
    await conflictCard.getByRole('button', { name: 'Approve' }).click()
    const dialog = page.getByRole('dialog', { name: 'Resolve Group Conflict' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Reception').check()
    await dialog.getByRole('button', { name: 'Apply' }).click()
    await expect(dialog).toHaveCount(0)

    await page.getByRole('link', { name: 'Devices' }).click()
    await page.getByPlaceholder('Search ID, alias, host, user…').fill('w-sf-it-1')
    await expect(page.getByRole('row').filter({ hasText: 'w-sf-it-1' })).toContainText('Reception')
    await page.getByRole('row').filter({ hasText: 'w-sf-it-1' }).getByRole('link').first().click()
    await expect(page.getByText('Group conflict')).toHaveCount(0)
  })

  test('device conflict flag opens resolution and can be dismissed in place', async ({ page }) => {
    await page.goto('/devices/queue')
    await queueCard(page, 'w-sf-it-1').getByRole('button', { name: 'Approve' }).click()
    const conflictDialog = page.getByRole('dialog', { name: 'Resolve Group Conflict' })
    await expect(conflictDialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(conflictDialog).toHaveCount(0)

    await page.getByRole('link', { name: 'Devices' }).click()
    await page.getByPlaceholder('Search ID, alias, host, user…').fill('w-sf-it-1')
    await page.getByRole('row').filter({ hasText: 'w-sf-it-1' }).getByRole('link').first().click()
    await page.getByRole('button', { name: 'Resolve conflict…' }).click()
    await expect(conflictDialog).toBeVisible()
    await conflictDialog.getByLabel('Keep where it is').check()
    await conflictDialog.getByRole('button', { name: 'Apply' }).click()
    await expect(conflictDialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Resolve conflict…' })).toHaveCount(0)
  })

  test('mass approval suppresses the conflict dialog and reports the flagged device', async ({
    page,
  }) => {
    await page.goto('/devices/queue')
    await queueCard(page, 'w-sf-it-1').getByRole('checkbox').check()
    await page
      .locator('[data-device-id]')
      .filter({ hasNotText: 'w-sf-it-1' })
      .first()
      .getByRole('checkbox')
      .check()
    await page.getByRole('button', { name: /Approve \(2\)/ }).click()
    const confirmation = page.getByRole('dialog', { name: 'Approve 2 devices?' })
    await confirmation.getByRole('button', { name: 'Approve 2' }).click()
    await expect(page.getByRole('dialog', { name: 'Resolve Group Conflict' })).toHaveCount(0)
    await expect(page.locator('[data-slot="toast-title"]')).toContainText('2 devices approved')
    // Radix also announces the toast in a transient role=status span; getByText would match both.
    await expect(page.locator('[data-slot="toast-description"]')).toContainText(
      '1 need a group choice',
    )
  })

  test('owner can run Auto Sort All after reviewing the warning; admin cannot', async ({
    page,
  }) => {
    await page.goto('/groups')
    await page.getByRole('button', { name: 'Auto-sort rules for Office' }).click()
    const field = page.getByRole('textbox', { name: 'Add pattern for Office' })
    await field.fill('*')
    await expect(page.getByText(/Matches \d+ devices? \(\d+ pending\)/)).toBeVisible()
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByRole('button', { name: 'Auto Sort All' }).click()
    const dialog = page.getByRole('dialog', { name: 'Auto Sort All' })
    await expect(dialog).toContainText(/\d+ devices will move, \d+ conflicts, \d+ unchanged/)
    const confirm = dialog.getByRole('button', { name: 'Auto sort all' })
    await expect(confirm).toBeDisabled()
    await dialog.getByRole('checkbox').check()
    await expect(confirm).toBeEnabled()
    await confirm.click()
    await expect(dialog).toContainText('Auto sort complete')
    await expect(dialog).toContainText(/Moved: \d+ devices/)
    await expect(dialog).toContainText(/Conflicts flagged: \d+ devices/)
    await expect(dialog).toContainText(/Unchanged: \d+ devices/)

    await page.goto('/groups?mock-role=admin')
    await expect(page.getByRole('heading', { level: 1, name: 'Groups' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Auto Sort All' })).toHaveCount(0)
  })

  test('bulk move shows its policy warning and delete shows its session history warning', async ({
    page,
  }) => {
    await page.goto('/devices?state=approved')
    const rows = page.getByRole('row')
    await rows.nth(1).getByRole('checkbox').check()
    await rows.nth(2).getByRole('checkbox').check()
    await page.getByRole('button', { name: /Move to group \(2\)/ }).click()
    const moveDialog = page.getByRole('dialog', { name: 'Move to Group' })
    await expect(moveDialog).toContainText(
      'will move to the selected group and take its client policy',
    )
    await moveDialog.getByRole('button', { name: 'Select a group…' }).click()
    await page.getByRole('combobox', { name: 'Search groups' }).fill('Home lab')
    await page.getByRole('treeitem', { name: 'Home lab' }).click()
    await moveDialog.getByRole('button', { name: 'Move devices' }).click()
    await expect(page.locator('[data-slot="toast-title"]')).toContainText('Moved 2 of 2')

    await rows.nth(1).getByRole('checkbox').check()
    await rows.nth(2).getByRole('checkbox').check()
    await page.getByRole('button', { name: /Delete \(2\)/ }).click()
    const deleteDialog = page.getByRole('dialog', { name: 'Delete 2 devices?' })
    await expect(deleteDialog).toContainText('Their session history is deleted too.')
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`zero critical/serious Groups a11y violations with rules open in ${theme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto('/groups')
      await page.getByRole('button', { name: 'Auto-sort rules for Office' }).click()
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      )
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
      expect(
        results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious'),
      ).toEqual([])
    })

    test(`zero critical/serious Auto Sort warning a11y violations in ${theme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto('/groups')
      await page.getByRole('button', { name: 'Auto Sort All' }).click()
      await expect(page.getByRole('dialog', { name: 'Auto Sort All' })).toBeVisible()
      await expect(
        page.getByText(/\d+ devices will move, \d+ conflicts, \d+ unchanged/),
      ).toBeVisible()
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      )
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
      expect(
        results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious'),
      ).toEqual([])
    })
  }
})
