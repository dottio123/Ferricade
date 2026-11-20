import { expect, test } from './support/test'

const ALLOWED_AUTH_ERRORS =
  /status of (401|423) .*\/admin\/api\/v1\/auth\/(me|login)|status of (400|423) .*\/admin\/api\/v1\/auth\/totp/

test.describe('Responsive mobile layout (390px viewport)', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    allowConsoleErrors: [ALLOWED_AUTH_ERRORS],
  })

  test('navigation drawer opens on mobile and links close the drawer', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    // Desktop sidebar should be hidden
    const desktopSidebar = page.locator('aside')
    await expect(desktopSidebar).toBeHidden()

    // Top-bar hamburger button should be visible
    const hamburger = page.getByRole('button', { name: 'Open navigation menu' })
    await expect(hamburger).toBeVisible()

    // Click hamburger to open mobile navigation sheet
    await hamburger.click()
    const mobileNav = page.locator('nav[aria-label="Mobile navigation"]')
    await expect(mobileNav).toBeVisible()

    // Click Devices link in mobile nav
    const devicesLink = mobileNav.getByRole('link', { name: 'Devices' })
    await devicesLink.click()

    // Should navigate to /devices and drawer should close
    await expect(page).toHaveURL(/\/devices/)
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
    await expect(mobileNav).toBeHidden()
  })

  test('Fleet overview fits its card without horizontal page scroll at 390px', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    const fleetModule = page.locator('[data-module-id="fleet-overview"]')
    await expect(fleetModule.locator('[data-slot="fleet-overview-body"]')).toBeVisible()
    const widths = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }))
    expect(widths.page).toBeLessThanOrEqual(widths.viewport)
    const box = await fleetModule.boundingBox()
    expect(box).not.toBeNull()
    await expect(fleetModule.locator('[data-slot="fleet-overview-body"]')).toHaveCSS(
      'overflow-y',
      'auto',
    )
  })

  test('devices list shows cards with visible actions below md', async ({ page }) => {
    await page.goto('/devices')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
    const mobileCards = page.locator('[data-slot="devices-mobile-cards"]')
    await expect(
      mobileCards,
      'Devices list should render mobile cards container below md',
    ).toBeVisible()
    const cards = mobileCards.locator('[data-slot="device-card"]')
    await expect(cards.first()).toBeVisible()
    expect(await cards.count()).toBeGreaterThan(0)
    // First card actions must be visible
    const firstCard = cards.first()
    await expect(firstCard.locator('[data-slot="device-card-actions"]')).toBeVisible()
  })

  for (const path of ['/', '/devices', '/sessions', '/account']) {
    test(`touch targets at least 44x44 on ${path} with coarse pointer`, async ({ page }) => {
      await page.goto(path)
      // Allow data to load
      await page.waitForLoadState('networkidle')

      const violations = await page.evaluate(() => {
        const issues: {
          selector: string
          width: number
          height: number
          text: string
          kind?: 'size' | 'obscured'
          hitTag?: string
          hitClass?: string
        }[] = []
        // Candidate interactive elements: button, a, input[type=checkbox], input[type=search], select
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>(
            'button, a, input[type="checkbox"], input[type="radio"], [role="button"]',
          ),
        )

        for (const el of candidates) {
          // Check if element is visible and in layout
          if (el.offsetWidth === 0 && el.offsetHeight === 0) continue
          const style = window.getComputedStyle(el)
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            continue
          }

          // Measure base bounding rect
          const rect = el.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) continue

          // Exceptions:
          // 1. Skip links that are hidden or offscreen skip-navs
          if (el.getAttribute('href') === '#main-content') continue
          // 2. Hidden or internal sr-only
          if (el.classList.contains('sr-only')) continue

          const cx = rect.left + rect.width / 2
          const cy = rect.top + rect.height / 2
          if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
            const hit = document.elementFromPoint(cx, cy)
            if (hit && hit !== el && !el.contains(hit)) {
              const id = el.id ? `#${el.id}` : ''
              const cls = (typeof el.className === 'string' ? el.className.split(' ')[0] : '') || ''
              const desc = `${el.tagName.toLowerCase()}${id}.${cls}`
              const hitClass =
                typeof hit.className === 'string' ? hit.className.split(' ')[0] || '' : ''
              issues.push({
                selector: desc,
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                text: (el.textContent || el.getAttribute('aria-label') || '').slice(0, 30).trim(),
                kind: 'obscured',
                hitTag: hit.tagName.toLowerCase(),
                hitClass,
              })
            }
          }

          let effectiveWidth = rect.width
          let effectiveHeight = rect.height

          // Inspect pseudo-elements ::before and ::after
          for (const pseudo of ['::before', '::after']) {
            const pStyle = window.getComputedStyle(el, pseudo)
            if (pStyle.content && pStyle.content !== 'none') {
              const pW = parseFloat(pStyle.width) || 0
              const pH = parseFloat(pStyle.height) || 0
              const pMinW = parseFloat(pStyle.minWidth) || 0
              const pMinH = parseFloat(pStyle.minHeight) || 0
              effectiveWidth = Math.max(effectiveWidth, pW, pMinW)
              effectiveHeight = Math.max(effectiveHeight, pH, pMinH)
            }
          }

          if (effectiveWidth < 43.5 || effectiveHeight < 43.5) {
            const id = el.id ? `#${el.id}` : ''
            const cls = (typeof el.className === 'string' ? el.className.split(' ')[0] : '') || ''
            const desc = `${el.tagName.toLowerCase()}${id}.${cls}`
            issues.push({
              selector: desc,
              width: Math.round(effectiveWidth),
              height: Math.round(effectiveHeight),
              text: (el.textContent || el.getAttribute('aria-label') || '').slice(0, 30).trim(),
              kind: 'size',
            })
          }
        }
        return issues
      })

      expect(
        violations,
        `Touch-target or centre-hit violations on ${path}: ${JSON.stringify(violations.slice(0, 5))}`,
      ).toEqual([])
    })
  }

  test('mobile account TOTP and device audit entries fit at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/account')

    const reenroll = page.getByRole('button', { name: 'Re-enroll authenticator' })
    await expect(reenroll).toBeVisible()
    const reenrollBox = await reenroll.boundingBox()
    const totpCardBox = await reenroll.locator('xpath=..').boundingBox()
    expect(reenrollBox).not.toBeNull()
    expect(totpCardBox).not.toBeNull()
    expect(reenrollBox!.x).toBeGreaterThanOrEqual(totpCardBox!.x - 0.5)
    expect(reenrollBox!.x + reenrollBox!.width).toBeLessThanOrEqual(
      totpCardBox!.x + totpCardBox!.width + 0.5,
    )
    await page.goto('/audit')
    await page.locator('[data-slot="audit-event-item"] [data-slot="device-link"]').first().click()
    await expect(page.locator('[data-slot="device-detail"]')).toBeVisible()
    const entry = page.locator('[data-slot="device-audit-entry"]').first()
    await expect(entry).toBeVisible()
    const entryBox = await entry.boundingBox()
    const actionBox = await entry.locator('[data-slot="device-audit-action"]').boundingBox()
    const actorBox = await entry.locator('[data-slot="device-audit-actor"]').boundingBox()
    expect(entryBox).not.toBeNull()
    expect(actionBox).not.toBeNull()
    expect(actorBox).not.toBeNull()
    expect(actorBox!.y).toBeGreaterThanOrEqual(actionBox!.y + actionBox!.height - 0.5)
    expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(entryBox!.x + entryBox!.width + 0.5)
    expect(actorBox!.x + actorBox!.width).toBeLessThanOrEqual(entryBox!.x + entryBox!.width + 0.5)
  })

  const routes: { name: string; path: string; heading: string; mainSelector?: string }[] = [
    {
      name: 'Command Center',
      path: '/',
      heading: 'Command Center',
      mainSelector: '[data-slot="dashboard-grid"]',
    },
    {
      name: 'Devices list',
      path: '/devices',
      heading: 'Devices',
      mainSelector: '[data-slot="devices-table"]',
    },
    {
      name: 'Approval Queue',
      path: '/devices/queue',
      heading: 'Approval Queue',
      mainSelector: '[data-slot="queue-bulk-toolbar"]',
    },
    {
      name: 'Sessions',
      path: '/sessions',
      heading: 'Sessions',
      mainSelector: '[data-slot="sessions-table-wrapper"]',
    },
    {
      name: 'Audit Log',
      path: '/audit',
      heading: 'Audit Log',
      mainSelector: 'main',
    },
    {
      name: 'Groups',
      path: '/groups',
      heading: 'Groups',
      mainSelector: '[data-slot="groups-page"]',
    },
    {
      name: 'Tags',
      path: '/tags',
      heading: 'Tags',
      mainSelector: '[data-slot="tags-page"]',
    },
    {
      name: 'Policies',
      path: '/policies',
      heading: 'Client Policies',
    },
    {
      name: 'Users',
      path: '/settings/users',
      heading: 'Users',
      mainSelector: '[data-slot="users-page"]',
    },
    { name: 'Settings index', path: '/settings', heading: 'Settings' },
    { name: 'Server settings', path: '/settings/server', heading: 'Server' },
    { name: 'Fleet Thresholds', path: '/settings/thresholds', heading: 'Fleet Thresholds' },
    { name: 'Account settings', path: '/account', heading: 'Account' },
    { name: 'Appearance settings', path: '/account/appearance', heading: 'Appearance' },
    { name: 'Dashboard Layout', path: '/account/dashboard', heading: 'Dashboard Layout' },
  ]

  for (const { name, path, heading, mainSelector } of routes) {
    test(`no horizontal overflow on ${name} (${path})`, async ({ page }) => {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
      if (mainSelector) {
        await expect(page.locator(mainSelector).first()).toBeVisible()
      }

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
      expect(
        scrollWidth,
        `Expected document.documentElement.scrollWidth <= 390 on ${path}`,
      ).toBeLessThanOrEqual(390)
    })
  }

  test('no horizontal overflow on sign-in page', async ({ page }) => {
    await page.goto('/sign-in?mock-session=signed-out')
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scrollWidth).toBeLessThanOrEqual(390)
  })

  test('no horizontal overflow on sign-in TOTP page', async ({ page }) => {
    await page.goto('/sign-in?mock-session=signed-out')
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()

    await page.getByLabel('Username').fill('alex')
    await page.getByLabel('Password').fill('correct horse battery')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByRole('heading', { level: 1, name: 'Two-factor code' })).toBeVisible()

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scrollWidth).toBeLessThanOrEqual(390)
  })
})

test.describe('Large text zoom (200% font size at 1280x800)', () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    allowConsoleErrors: [ALLOWED_AUTH_ERRORS],
  })

  test('no horizontal overflow and no module overflow on / at 200% text size', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    // Apply 200% text size
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%'
    })

    // Allow reflow
    await page.waitForTimeout(500)

    // Check no horizontal page overflow
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(
      scrollWidth,
      `Expected document.documentElement.scrollWidth <= 1280 at 200% text size, got ${scrollWidth}`,
    ).toBeLessThanOrEqual(1280)

    // Check no module whose content overflows its box on /
    const overflowCheck = await page.evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll<HTMLElement>('[data-slot="dashboard-module-card"]'),
      )
      const overflowingModules: { title: string; cardHeight: number; contentHeight: number }[] = []

      for (const card of cards) {
        const titleEl = card.querySelector('[data-slot="card-title"]')
        const title = titleEl?.textContent?.trim() || 'Unknown module'
        const content = card.querySelector<HTMLElement>('[data-slot="card-content"]')
        if (!content) continue

        // Compare content scrollHeight vs clientHeight (allow 2px margin)
        if (content.scrollHeight > content.clientHeight + 2) {
          overflowingModules.push({
            title,
            cardHeight: card.clientHeight,
            contentHeight: content.scrollHeight,
          })
        }
      }
      return overflowingModules
    })

    expect(
      overflowCheck,
      `Modules with overflowing content at 200% text size: ${JSON.stringify(overflowCheck)}`,
    ).toEqual([])
  })
})
