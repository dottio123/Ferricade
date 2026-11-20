import type { Page } from '@playwright/test'
import { expect, mockReady, test } from './support/test'

async function ensurePreset(page: Page, preset: 'wall' | 'business') {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible({
    timeout: 10000,
  })
  const grid = page.locator('[data-slot="dashboard-grid"]')
  const currentPreset = await grid.getAttribute('data-preset')
  if (preset === 'wall' && currentPreset === 'wall') return
  if (preset === 'business' && currentPreset !== 'wall') return

  if (currentPreset === 'wall') {
    await page.getByRole('button', { name: 'Change layout' }).click()
  } else {
    await page.getByRole('button', { name: 'Customize' }).click()
  }
  const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
  await expect(drawer).toBeVisible()
  const presetName = preset === 'wall' ? 'Monitoring wall' : 'Business'
  await drawer.getByRole('button', { name: presetName }).click()
  await drawer.getByRole('button', { name: 'Save layout' }).click()
  await expect(drawer).toBeHidden()
  if (preset === 'wall') {
    await expect(grid).toHaveAttribute('data-preset', 'wall')
  }
}

test.describe('Monitoring wall & Kiosk mode', () => {
  test.setTimeout(60_000)

  test('1920x1080 normal mode: 5 modules visible, zero scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await ensurePreset(page, 'wall')

    await expect(page.locator('[data-slot="dashboard-grid"]')).toHaveAttribute(
      'data-preset',
      'wall',
    )

    // 5 modules visible
    await expect(page.locator('[data-module-id="fleet-pulse"]')).toBeVisible()
    await expect(page.locator('[data-module-id="needs-attention"]')).toBeVisible()
    await expect(page.locator('[data-module-id="live-sessions"]')).toBeVisible()
    await expect(page.locator('[data-module-id="fleet-overview"]')).toBeVisible()
    await expect(page.locator('[data-module-id="activity-trend"]')).toBeVisible()

    // Non-wall modules are not visible
    await expect(page.locator('[data-module-id="approval-queue"]')).toBeHidden()
    await expect(page.locator('[data-module-id="quick-connect"]')).toBeHidden()

    // Zero vertical scrollbar: document scrollHeight === clientHeight
    const fitsWithoutScroll = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement
      return el.scrollHeight <= window.innerHeight + 1
    })
    expect(fitsWithoutScroll).toBe(true)
  })

  test('1920x1080 kiosk mode: no nav landmark, search hidden, live indicator shows Live', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await ensurePreset(page, 'wall')
    await page.goto('/?kiosk=1')

    // No nav landmark
    await expect(page.locator('nav')).toHaveCount(0)

    // Search button hidden
    await expect(page.locator('[data-slot="search-trigger"]')).toBeHidden()

    // Live indicator shows Live
    const status = page.locator('[data-slot="kiosk-status"]')
    await expect(status).toBeVisible()
    await expect(status).toContainText('Live')
  })

  test('kiosk status reflects RustDesk server health', async ({ page }) => {
    // Two health refetches (30 s interval each): degraded, then recovered.
    test.setTimeout(100_000)
    await page.setViewportSize({ width: 1920, height: 1080 })
    await ensurePreset(page, 'wall')
    await page.goto('/?kiosk=1')
    await mockReady(page)

    const status = page.locator('[data-slot="kiosk-status"]')
    await expect(status).toContainText('Live')
    await page.evaluate(() =>
      window.__ferricadeMock!.setServerCheck('relay', false, 'relay connection refused'),
    )
    await expect(status).toContainText('RustDesk server issue', { timeout: 35_000 })
    await page.evaluate(() => window.__ferricadeMock!.setServerCheck('relay', true))
    await expect(status).toContainText('Live', { timeout: 35_000 })
  })

  test('1920x1080 kiosk font sizes: fleet pulse >= 64px, titles >= 18px, text nodes >= 14px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await ensurePreset(page, 'wall')
    await page.goto('/?kiosk=1')

    // Fleet pulse numbers >= 64px
    await expect(page.locator('[data-slot="pulse-number"]').first()).toBeVisible()
    const pulseSizes = await page
      .locator('[data-slot="pulse-number"]')
      .evaluateAll((els) => els.map((el) => parseFloat(window.getComputedStyle(el).fontSize)))
    expect(pulseSizes.length).toBeGreaterThan(0)
    for (const size of pulseSizes) {
      expect(Math.round(size)).toBeGreaterThanOrEqual(64)
    }

    // Card titles >= 18px
    const titleSizes = await page
      .locator('[data-slot="card-title"]')
      .evaluateAll((els) => els.map((el) => parseFloat(window.getComputedStyle(el).fontSize)))
    expect(titleSizes.length).toBeGreaterThan(0)
    for (const size of titleSizes) {
      expect(size).toBeGreaterThanOrEqual(18)
    }

    // Every text node in grid >= 14px
    const smallTextNodes = await page.evaluate(() => {
      const grid = document.querySelector('[data-slot="dashboard-grid"]')
      if (!grid) return []
      const walker = document.createTreeWalker(grid, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT
          const parent = node.parentElement
          if (!parent) return NodeFilter.FILTER_REJECT
          const style = window.getComputedStyle(parent)
          if (style.display === 'none' || style.visibility === 'hidden')
            return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        },
      })
      const violations: { text: string; size: number }[] = []
      let node
      while ((node = walker.nextNode())) {
        const parent = node.parentElement!
        const fontSize = parseFloat(window.getComputedStyle(parent).fontSize)
        if (fontSize < 13.9) {
          violations.push({ text: node.textContent?.trim() || '', size: fontSize })
        }
      }
      return violations
    })
    expect(smallTextNodes).toEqual([])
  })

  test('1366x768 kiosk mode: no text node under 14px, no module content overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 })
    await ensurePreset(page, 'wall')
    await page.goto('/?kiosk=1')

    // Verify all 5 module cards render
    const cards = page.locator('[data-slot="dashboard-module-card"]')
    await expect(cards).toHaveCount(5)

    // No text node under 14px
    const smallTextNodes = await page.evaluate(() => {
      const grid = document.querySelector('[data-slot="dashboard-grid"]')
      if (!grid) return []
      const walker = document.createTreeWalker(grid, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT
          const parent = node.parentElement
          if (!parent) return NodeFilter.FILTER_REJECT
          const style = window.getComputedStyle(parent)
          if (style.display === 'none' || style.visibility === 'hidden')
            return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        },
      })
      const violations: { text: string; size: number }[] = []
      let node
      while ((node = walker.nextNode())) {
        const parent = node.parentElement!
        const fontSize = parseFloat(window.getComputedStyle(parent).fontSize)
        if (fontSize < 13.9) {
          violations.push({ text: node.textContent?.trim() || '', size: fontSize })
        }
      }
      return violations
    })
    expect(smallTextNodes).toEqual([])

    // No module content overflow (using module-fit logic)
    for (const card of await cards.all()) {
      const content = card.locator('[data-slot="card-content"]')
      const metrics = await content.evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }))
      expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1)
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
    }
  })

  test('Escape exits kiosk; Tabbing once focuses Exit kiosk and activating it exits kiosk', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await ensurePreset(page, 'wall')
    await page.goto('/')

    // Click Kiosk mode button
    await page.getByRole('link', { name: 'Kiosk mode' }).click()
    await expect(page).toHaveURL(/\/\?kiosk=(1|true)/)
    await expect(page.locator('nav')).toHaveCount(0)

    // Press Escape to exit
    await page.keyboard.press('Escape')
    await expect(page).not.toHaveURL(/kiosk/)
    await expect(page.locator('nav')).toBeVisible()

    // Re-enter kiosk mode
    await page.goto('/?kiosk=1')
    await expect(page.locator('nav')).toHaveCount(0)

    // Wait for Exit kiosk button to be attached, then Tab once from top
    const exitButton = page.locator('[data-slot="exit-kiosk-button"]')
    await expect(exitButton).toBeAttached()
    await page.locator('body').focus()
    await page.keyboard.press('Tab')
    await expect(exitButton).toBeFocused()

    // Activate it via Enter
    await page.keyboard.press('Enter')
    await expect(page).not.toHaveURL(/kiosk=1/)
    await expect(page.locator('nav')).toBeVisible()
  })

  test('/?kiosk=1 with Business preset renders normal page (sidebar visible)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await ensurePreset(page, 'business')
    await page.goto('/?kiosk=1')

    // Sidebar should remain visible
    await expect(page.locator('nav')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    await expect(page.locator('[data-slot="exit-kiosk-button"]')).toBeHidden()
  })

  test('Device panel overlay: opening from Needs attention in kiosk keeps kiosk=1 + device=; first Escape closes panel, second Escape exits kiosk', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await ensurePreset(page, 'wall')
    await page.goto('/?kiosk=1')

    // Find a device link in Needs attention
    const needsAttentionCard = page.locator('[data-module-id="needs-attention"]')
    const deviceLink = needsAttentionCard.locator('[data-slot="device-link"]').first()
    await expect(deviceLink).toBeVisible()
    await deviceLink.click()

    // URL should have both kiosk=1 and device=
    await expect(page).toHaveURL(/kiosk=(1|true)/)
    await expect(page).toHaveURL(/device=/)

    // Device sheet dialog should be visible
    const sheet = page.getByRole('dialog')
    await expect(sheet).toBeVisible()

    // First Escape closes panel
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(page).toHaveURL(/kiosk=(1|true)/)
    await expect(page).not.toHaveURL(/device=/)
    await expect(page.locator('nav')).toHaveCount(0)

    // Second Escape exits kiosk
    await page.keyboard.press('Escape')
    await expect(page).not.toHaveURL(/kiosk/)
    await expect(page.locator('nav')).toBeVisible()
  })

  test('Business preset at 1440x900: fleet pulse number computed font size equals 30px (text-3xl)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await ensurePreset(page, 'business')
    await page.goto('/')

    const firstNumber = page.locator('[data-slot="pulse-number"]').first()
    await expect(firstNumber).toBeVisible()
    const fontSize = await firstNumber.evaluate((el) =>
      parseFloat(window.getComputedStyle(el).fontSize),
    )
    expect(Math.round(fontSize)).toBe(30)
  })

  test('Reconnection indicator: dropEventStreams(12000) shows Reconnecting... then Live', async ({
    page,
  }) => {
    test.setTimeout(30_000)
    await page.setViewportSize({ width: 1920, height: 1080 })
    await ensurePreset(page, 'wall')
    await page.goto('/?kiosk=1')

    await mockReady(page)
    const status = page.locator('[data-slot="kiosk-status"]')
    await expect(status).toBeVisible()
    await expect(status).toContainText('Live')

    // Drop event streams for 12 seconds (LIVE_TIMING.reconnectingAfterMs is 10s)
    await page.evaluate(() => window.__ferricadeMock!.dropEventStreams(12000))

    // Should transition to Reconnecting...
    await expect(status).toContainText('Reconnecting', { timeout: 15000 })

    // Should recover back to Live
    await expect(status).toContainText('Live', { timeout: 20000 })
  })

  test('wall saved, 1440x900, /audit: content taller than viewport scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await ensurePreset(page, 'wall')
    await page.goto('/audit')
    await expect(page.getByRole('heading', { level: 1, name: 'Audit Log' })).toBeVisible()
    await expect(page.locator('[data-slot="audit-timeline"]')).toBeVisible()

    const scrollMetrics = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement
      const initialY = window.scrollY
      window.scrollBy(0, 100)
      const afterY = window.scrollY
      return {
        scrollHeight: el.scrollHeight,
        innerHeight: window.innerHeight,
        initialY,
        afterY,
      }
    })
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.innerHeight)
    expect(scrollMetrics.afterY).toBeGreaterThan(scrollMetrics.initialY)
  })

  test('wall saved, 1366x768, normal mode on /: last module bottom edge is reachable', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 })
    await ensurePreset(page, 'wall')
    await page.goto('/')

    const lastCard = page.locator('[data-module-id="activity-trend"]')
    await expect(lastCard).toBeVisible()
    await lastCard.scrollIntoViewIfNeeded()
    const isReachable = await lastCard.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      return rect.bottom <= window.innerHeight + 1 && rect.top >= 0
    })
    expect(isReachable).toBe(true)
  })

  test('wall saved, 390x844 on /: modules stack and last module is reachable by scrolling', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await ensurePreset(page, 'wall')
    await page.goto('/')

    const lastCard = page.locator('[data-module-id="activity-trend"]')
    await expect(lastCard).toBeVisible()
    await lastCard.scrollIntoViewIfNeeded()
    const isReachable = await lastCard.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      return rect.bottom <= window.innerHeight + 1
    })
    expect(isReachable).toBe(true)
  })

  test('wall saved, /devices?kiosk=1: still shows sidebar (kiosk applies only on /)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await ensurePreset(page, 'wall')
    await page.goto('/devices?kiosk=1')

    await expect(page.locator('aside nav')).toBeVisible()
    await expect(page.locator('[data-slot="exit-kiosk-button"]')).toBeHidden()
  })

  test('wall shows +N more when more attention items or live sessions exist than fit', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 })
    await ensurePreset(page, 'wall')
    await page.goto('/')

    const needsAttentionCard = page.locator('[data-module-id="needs-attention"]')
    await expect(needsAttentionCard).toBeVisible()

    const attentionRowItems = needsAttentionCard.locator('[data-slot="device-link"]')
    const attentionMore = needsAttentionCard.locator('[data-slot="wall-more"]')
    await expect(async () => {
      const totalAttention = await page.evaluate(async () => {
        const res = await fetch('/admin/api/v1/stats/summary')
        const data = await res.json()
        return data.attention?.length ?? 0
      })
      await expect(attentionRowItems.first()).toBeVisible()
      const attentionRows = await attentionRowItems.count()
      expect(totalAttention).toBeGreaterThan(attentionRows)

      const expectedAttentionHidden = totalAttention - attentionRows
      await expect(attentionMore).toBeVisible()
      await expect(attentionMore).toContainText(`+${expectedAttentionHidden} more`)
    }).toPass({ timeout: 10_000 })

    // Check Live sessions
    const liveSessionsCard = page.locator('[data-module-id="live-sessions"]')
    await expect(liveSessionsCard).toBeVisible()

    const sessionRowItems = liveSessionsCard.locator('[data-slot="live-session-item"]')
    const sessionsMore = liveSessionsCard.locator('[data-slot="wall-more"]')
    await expect(async () => {
      const totalSessions = await page.evaluate(async () => {
        const res = await fetch('/admin/api/v1/sessions?active=true&authenticated=true')
        const data = await res.json()
        return data.items?.length ?? 0
      })
      await expect(sessionRowItems.first()).toBeVisible()
      const sessionRows = await sessionRowItems.count()
      expect(totalSessions).toBeGreaterThan(sessionRows)

      const expectedSessionsHidden = totalSessions - sessionRows
      await expect(sessionsMore).toBeVisible()
      await expect(sessionsMore).toContainText(`+${expectedSessionsHidden} more`)
    }).toPass({ timeout: 10_000 })

    // At 1920x1200 in kiosk mode, more items fit than at 1366x768 (not capped at 2)
    await page.setViewportSize({ width: 1920, height: 1200 })
    await page.goto('/?kiosk=1')

    const kNeedsAttention = page.locator('[data-module-id="needs-attention"]')
    await expect(kNeedsAttention).toBeVisible()
    const kAttentionRowItems = kNeedsAttention.locator('[data-slot="device-link"]')
    const kAttentionMore = kNeedsAttention.locator('[data-slot="wall-more"]')
    await expect(async () => {
      const kTotalAttention = await page.evaluate(async () => {
        const res = await fetch('/admin/api/v1/stats/summary')
        const data = await res.json()
        return data.attention?.length ?? 0
      })
      await expect(kAttentionRowItems.first()).toBeVisible()
      const kAttentionRows = await kAttentionRowItems.count()
      expect(kAttentionRows).toBeGreaterThan(2)

      const kExpectedAttentionHidden = kTotalAttention - kAttentionRows
      if (kExpectedAttentionHidden > 0) {
        await expect(kAttentionMore).toBeVisible()
        await expect(kAttentionMore).toContainText(`+${kExpectedAttentionHidden} more`)
      }
    }).toPass({ timeout: 10_000 })

    // With large mock dataset (25 active sessions), live-sessions also shows +N more at 1920x1200
    await page.goto('/?kiosk=1&mock=large')
    const largeLiveSessions = page.locator('[data-module-id="live-sessions"]')
    await expect(largeLiveSessions).toBeVisible()

    const largeSessionRowItems = largeLiveSessions.locator('[data-slot="live-session-item"]')
    const largeSessionsMore = largeLiveSessions.locator('[data-slot="wall-more"]')
    await expect(async () => {
      const largeTotalSessions = await page.evaluate(async () => {
        const res = await fetch('/admin/api/v1/sessions?active=true&authenticated=true')
        const data = await res.json()
        return data.items?.length ?? 0
      })
      await expect(largeSessionRowItems.first()).toBeVisible()
      const largeSessionRows = await largeSessionRowItems.count()
      expect(largeTotalSessions).toBeGreaterThan(largeSessionRows)
      const largeExpectedHidden = largeTotalSessions - largeSessionRows
      await expect(largeSessionsMore).toBeVisible()
      await expect(largeSessionsMore).toContainText(`+${largeExpectedHidden} more`)
    }).toPass({ timeout: 10_000 })
  })
})
