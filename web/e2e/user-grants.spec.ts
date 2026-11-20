// An owner makes an account a User and chooses what it sees: groups (each covers
// its subgroups) and devices; and maps provider groups to the User role.
import { expect, test } from './support/test'

test.use({ allowConsoleErrors: [/status of 403 .*\/users/] })

const WARNING = 'Changing this role removes the devices and groups assigned to this account.'

test('an owner makes an account a User, assigns a group and a device, and sees them again', async ({
  page,
}) => {
  await page.goto('/settings/users')
  const table = page.getByRole('table')

  // Make sam a User: the dialog warns that the grants are removed on a role change to User.
  await table.getByRole('button', { name: 'Edit user sam' }).click()
  await page.locator('#user-edit-role').click()
  await page.getByRole('option', { name: /^User/ }).click()
  await expect(page.getByText(WARNING)).toBeVisible()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(table.getByRole('button', { name: 'Assign devices to sam' })).toBeVisible()
  await expect(table.getByRole('button', { name: 'Assign devices to alex' })).toHaveCount(0)

  // helpdesk (a User in the fixtures) holds one group, which covers its subgroups.
  await table.getByRole('button', { name: 'Assign devices to helpdesk' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: /Assign devices to/ })).toBeVisible()
  const office = dialog.getByRole('checkbox', { name: 'Office', exact: true })
  await expect(office).toBeChecked()
  const reception = dialog.getByRole('checkbox', { name: 'Reception', exact: true })
  await expect(reception).toBeChecked()
  await expect(reception).toBeDisabled()
  await expect(reception).toHaveAttribute('aria-describedby', /.+/)
  await expect(dialog.getByRole('heading', { name: /^Groups/ })).toContainText('1')

  const home = dialog.getByRole('checkbox', { name: 'Home lab', exact: true })
  await expect(home).not.toBeChecked()
  await home.check()
  await expect(dialog.getByRole('heading', { name: /^Groups/ })).toContainText('2')

  const devices = dialog.getByRole('region', { name: 'Devices' })
  const devicesHeading = dialog.getByRole('heading', { name: /^Devices/ })
  const initialDevices = Number((await devicesHeading.innerText()).replace(/\D+/g, ''))
  const free = devices.locator('label', { has: page.locator('input:not(:checked)') }).first()
  await expect(free).toBeVisible()
  const deviceLabel = (await free.innerText()).replace(/\s+/g, ' ').trim()
  await free.getByRole('checkbox').check()
  await expect(devicesHeading).toContainText(String(initialDevices + 1))

  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Assigned devices saved', { exact: true })).toBeVisible()
  await expect(dialog).toHaveCount(0)

  // Reopened: the saved group and device come back checked.
  await table.getByRole('button', { name: 'Assign devices to helpdesk' }).click()
  await expect(dialog.getByRole('checkbox', { name: 'Home lab', exact: true })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'Office', exact: true })).toBeChecked()
  await expect(
    dialog.getByRole('region', { name: 'Devices' }).getByRole('checkbox', {
      name: deviceLabel,
    }),
  ).toBeChecked()
})

test('an admin has no Assign devices action', async ({ page }) => {
  await page.goto('/settings/users?mock-role=admin')
  await expect(page.getByText('Only owners can manage users.')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Assign devices/ })).toHaveCount(0)
})

test('the SSO page keeps the User groups it saved', async ({ page }) => {
  await page.goto('/settings/sign-in')
  await expect(page.getByLabel('Admin groups')).toBeVisible()
  await expect(page.getByText(/at least one owner, admin or user group/i)).toBeVisible()
  const userGroups = page.getByLabel('User groups')
  await userGroups.fill('helpdesk-staff')
  await userGroups.press('Enter')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Sign-in settings saved', { exact: true })).toBeVisible()

  // Away and back: the settings are read again.
  await page.getByRole('link', { name: 'Back to Settings' }).click()
  await page.getByRole('link', { name: /Sign-In/ }).click()
  await expect(
    page.getByRole('button', { name: 'Remove helpdesk-staff from User groups' }),
  ).toBeVisible()
})
