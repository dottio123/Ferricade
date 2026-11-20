import { expect, test } from './support/test'

test.describe('Design system accessibility and motion', () => {
  test('status dot pulse animation is disabled under prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/dev/kitchen-sink')

    const triggerBtn = page.getByRole('button', { name: 'Trigger status change pulse' })
    await expect(triggerBtn).toBeVisible()

    const dynamicDot = page.getByTestId('dynamic-pulse-container').getByTestId('status-dot')
    await expect(dynamicDot).toBeVisible()

    // Trigger state change
    await triggerBtn.click()

    // Evaluate computed animation style under reduced motion
    const animationName = await dynamicDot.evaluate(
      (el) => window.getComputedStyle(el).animationName,
    )
    expect(animationName).toBe('none')

    const animationDuration = await dynamicDot.evaluate(
      (el) => window.getComputedStyle(el).animationDuration,
    )
    expect(
      ['0s', '0.00001s', '0.01ms'].includes(animationDuration) ||
        parseFloat(animationDuration) <= 0.001,
    ).toBe(true)
  })

  test('status dot pulse animation activates when motion is allowed', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.goto('/dev/kitchen-sink')

    const triggerBtn = page.getByRole('button', { name: 'Trigger status change pulse' })
    await expect(triggerBtn).toBeVisible()

    const dynamicDot = page.getByTestId('dynamic-pulse-container').getByTestId('status-dot')
    await expect(dynamicDot).toBeVisible()

    // Trigger status change to start the pulse
    await triggerBtn.click()

    const animationName = await dynamicDot.evaluate(
      (el) => window.getComputedStyle(el).animationName,
    )
    expect(animationName).toBe('status-pulse')
  })
})
