import { expect, test } from './support/test'

const titles = [
  'Fleet pulse',
  'Quick connect',
  'Approval queue',
  'Needs attention',
  'Live sessions',
  'Activity trend',
  'Fleet overview',
  'Recent sessions',
  'Session analytics',
  'Platform mix',
  'Admin activity',
]
const businessTitles = [
  'Fleet pulse',
  'Approval queue',
  'Needs attention',
  'Live sessions',
  'Activity trend',
  'Fleet overview',
  'Platform mix',
  'Admin activity',
]

test('dashboard module headings, switches, and charts have accessible names or text alternatives', async ({
  page,
}) => {
  await page.goto('/')
  for (const title of businessTitles) {
    await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible()
  }

  await page.getByRole('button', { name: 'Customize' }).click()
  const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
  for (const title of titles) {
    await expect(drawer.getByRole('switch', { name: `Show ${title}` })).toBeVisible()
  }
  const sessionSwitch = drawer.getByRole('switch', { name: 'Show Session analytics' })
  if ((await sessionSwitch.getAttribute('data-state')) === 'unchecked') await sessionSwitch.click()
  await drawer.getByRole('button', { name: 'Save layout' }).click()

  await expect(page.getByRole('table', { name: 'Sessions per day, last 7 days' })).toBeAttached()
  await expect(page.getByRole('img', { name: /^Activity trend, / })).toBeAttached()
})
