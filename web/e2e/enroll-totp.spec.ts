import { expect, test } from './support/test'

const ENROLL_VERIFY_FAIL = /status of 400 .*\/admin\/api\/v1\/auth\/totp\/enroll\/verify/

test.use({ allowConsoleErrors: [ENROLL_VERIFY_FAIL] })

test.describe('TOTP Enrollment flow', () => {
  test('displays QR code and secret, rejects wrong code, and confirms with valid code', async ({
    page,
  }) => {
    await page.goto('/enroll-totp?mock-session=enroll')

    await expect(
      page.getByRole('heading', { level: 1, name: 'Set up two-factor authentication' }),
    ).toBeVisible()

    // QR code with role="img" must be visible
    const qrCode = page.getByRole('img', { name: 'QR code for your authenticator app' })
    await expect(qrCode).toBeVisible()

    // Secret key copy field must be visible
    await expect(page.getByLabel(/Secret key/)).toBeVisible()

    // Verification code input
    const codeInput = page.getByLabel('Verification code')
    await expect(codeInput).toBeVisible()

    // Submit invalid code
    await codeInput.fill('999999')
    await page.getByRole('button', { name: 'Verify and continue' }).click()

    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toHaveText("That code didn't match. Check your app and try again.")

    // Submit valid code
    await codeInput.fill('123456')
    await page.getByRole('button', { name: 'Verify and continue' }).click()

    // Confirmed enrollment navigates to Command Center
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
  })
})
