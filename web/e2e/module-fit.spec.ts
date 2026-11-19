import { expect, test } from './support/test'

test.describe('Dashboard module fit & no-clipping across sizes', () => {
  test('all catalog modules and sizes fit without clipping or overflow', async ({ page }) => {
    test.setTimeout(240_000)
    // 1. Initial load to establish session and load catalog and csrf token
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    // Read the catalog and csrf token dynamically from the API contract endpoints
    const { catalog, csrfToken } = await page.evaluate(async () => {
      const [authRes, catalogRes] = await Promise.all([
        fetch('/admin/api/v1/auth/me'),
        fetch('/admin/api/v1/dashboard/catalog'),
      ])
      if (!authRes.ok || !catalogRes.ok) {
        throw new Error(`Failed to fetch auth or catalog: ${authRes.status} / ${catalogRes.status}`)
      }
      const auth = await authRes.json()
      const catalog = await catalogRes.json()
      return { catalog, csrfToken: auth.csrf_token }
    })

    expect(catalog.modules.length).toBeGreaterThan(0)
    expect(csrfToken).toBeTruthy()

    for (const density of ['comfortable', 'compact'] as const) {
      for (const moduleDef of catalog.modules) {
        for (const sizeObj of moduleDef.sizes) {
          const size = sizeObj.name

          // Set preferences for this module & size with all other modules disabled at default_size
          const preferences = {
            preset: 'custom',
            modules: catalog.modules.map((m: { id: string; default_size: string }) => ({
              id: m.id,
              enabled: m.id === moduleDef.id,
              size: m.id === moduleDef.id ? size : m.default_size,
            })),
            pinned_device_ids: [],
            theme: 'system',
            density,
          }

          await page.evaluate(
            async ({ prefs, token }) => {
              const res = await fetch('/admin/api/v1/me/preferences', {
                method: 'PUT',
                headers: {
                  'Content-Type': 'application/json',
                  'X-CSRF-Token': token,
                },
                body: JSON.stringify(prefs),
              })
              if (!res.ok) {
                throw new Error(`Failed to set preferences: ${res.status}`)
              }
            },
            { prefs: preferences, token: csrfToken },
          )

          // Reload to apply the updated layout
          await page.reload()
          await expect(
            page.getByRole('heading', { level: 1, name: 'Command Center' }),
          ).toBeVisible()

          const targetModule = page.locator(`[data-module-id="${moduleDef.id}"]`)
          await expect(targetModule).toBeVisible()

          const card = targetModule.locator('[data-slot="dashboard-module-card"]')
          await expect(card).toBeVisible()
          // Wait for any module data loading skeletons to settle
          await expect(card.locator('[data-slot="skeleton"]')).toHaveCount(0)
          const normalBox = await card.boundingBox()
          expect(normalBox).not.toBeNull()

          const content = card.locator('[data-slot="card-content"]')
          await expect(content).toBeVisible()

          // Helper to check that every visible element stays within content bounds (bottom/right within 1px)
          const assertElementsWithinBounds = async (mode: 'normal' | 'edit') => {
            const boundsCheck = await content.evaluate((contentEl) => {
              const cardEl = contentEl.closest('[data-slot="dashboard-module-card"]')!
              const cardRect = cardEl.getBoundingClientRect()
              const contentRect = contentEl.getBoundingClientRect()
              const maxBottom = Math.min(contentRect.bottom, cardRect.bottom)
              const maxRight = Math.min(contentRect.right, cardRect.right)

              const descendants = Array.from(contentEl.querySelectorAll('*'))
              for (const el of descendants) {
                const htmlEl = el as HTMLElement
                if (htmlEl.offsetWidth === 0 && htmlEl.offsetHeight === 0) continue
                const style = window.getComputedStyle(htmlEl)
                if (
                  style.display === 'none' ||
                  style.visibility === 'hidden' ||
                  style.opacity === '0'
                ) {
                  continue
                }

                const rect = htmlEl.getBoundingClientRect()
                if (rect.bottom > maxBottom + 1.5) {
                  return {
                    ok: false,
                    reason: `Element <${htmlEl.tagName.toLowerCase()}> bottom (${rect.bottom.toFixed(1)}) exceeds card box bottom (${maxBottom.toFixed(1)} + 1px)`,
                  }
                }
                if (rect.right > maxRight + 1.5) {
                  return {
                    ok: false,
                    reason: `Element <${htmlEl.tagName.toLowerCase()}> right (${rect.right.toFixed(1)}) exceeds card box right (${maxRight.toFixed(1)} + 1px)`,
                  }
                }
              }
              return { ok: true }
            })
            expect(
              boundsCheck.ok ? null : boundsCheck.reason,
              `${moduleDef.id} at ${size} in ${mode} mode has overflowing element: ${boundsCheck.ok ? '' : boundsCheck.reason}`,
            ).toBeNull()
          }

          // 1. Normal mode assertions
          const normalMetrics = await content.evaluate((el) => ({
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
          }))
          expect(
            normalMetrics.scrollHeight,
            `Normal mode scrollHeight (${normalMetrics.scrollHeight}) exceeds clientHeight + 1 (${normalMetrics.clientHeight + 1}) for ${moduleDef.id} at ${size}`,
          ).toBeLessThanOrEqual(normalMetrics.clientHeight + 1)
          expect(
            normalMetrics.scrollWidth,
            `Normal mode scrollWidth (${normalMetrics.scrollWidth}) exceeds clientWidth + 1 (${normalMetrics.clientWidth + 1}) for ${moduleDef.id} at ${size}`,
          ).toBeLessThanOrEqual(normalMetrics.clientWidth + 1)

          await assertElementsWithinBounds('normal')

          // 2. Enter edit mode
          await page.getByRole('button', { name: 'Customize' }).click()
          const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
          await drawer.getByRole('button', { name: 'Close' }).click()
          await expect(drawer).toBeHidden()

          await expect(page.locator('[data-edit-mode="true"]').first()).toBeVisible()

          // Card's inner box has the same width and height in both modes (within 2 px)
          const editBox = await card.boundingBox()
          expect(editBox).not.toBeNull()
          expect(
            Math.abs(normalBox!.width - editBox!.width),
            `Card width difference between normal (${normalBox!.width}) and edit (${editBox!.width}) exceeds 2px for ${moduleDef.id} at ${size}`,
          ).toBeLessThanOrEqual(2)
          expect(
            Math.abs(normalBox!.height - editBox!.height),
            `Card height difference between normal (${normalBox!.height}) and edit (${editBox!.height}) exceeds 2px for ${moduleDef.id} at ${size}`,
          ).toBeLessThanOrEqual(2)

          // 3. Edit mode assertions
          const editMetrics = await content.evaluate((el) => ({
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
          }))
          expect(
            editMetrics.scrollHeight,
            `Edit mode scrollHeight (${editMetrics.scrollHeight}) exceeds clientHeight + 1 (${editMetrics.clientHeight + 1}) for ${moduleDef.id} at ${size}`,
          ).toBeLessThanOrEqual(editMetrics.clientHeight + 1)
          expect(
            editMetrics.scrollWidth,
            `Edit mode scrollWidth (${editMetrics.scrollWidth}) exceeds clientWidth + 1 (${editMetrics.clientWidth + 1}) for ${moduleDef.id} at ${size}`,
          ).toBeLessThanOrEqual(editMetrics.clientWidth + 1)

          await assertElementsWithinBounds('edit')

          // Exit edit mode for next iteration
          await page.getByRole('button', { name: 'Cancel' }).click()
          await expect(page.locator('[data-edit-mode="true"]')).toHaveCount(0)
        }
      }
    }
  })
})

test.describe('error states fit their box', () => {
  test.use({ allowConsoleErrors: [/status of 500/i] })

  test('each module with its query failing fits its box with Try again visible', async ({
    page,
  }) => {
    test.setTimeout(240_000)
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    const moduleFailOps: Record<string, string> = {
      'fleet-pulse': 'statsSummary',
      'quick-connect': 'listAudit',
      'approval-queue': 'listDevices',
      'needs-attention': 'statsSummary',
      'live-sessions': 'listSessions',
      'activity-trend': 'statsHistory',
      'fleet-overview': 'statsFleetMap',
      'recent-sessions': 'listSessions',
      'session-analytics': 'sessionStats',
      'platform-mix': 'statsSummary',
      'admin-activity': 'listAudit',
    }

    const { catalog, csrfToken } = await page.evaluate(async () => {
      const [authRes, catalogRes] = await Promise.all([
        fetch('/admin/api/v1/auth/me'),
        fetch('/admin/api/v1/dashboard/catalog'),
      ])
      const auth = await authRes.json()
      const catalog = await catalogRes.json()
      return { catalog, csrfToken: auth.csrf_token }
    })

    for (const moduleDef of catalog.modules) {
      const failOp = moduleFailOps[moduleDef.id]
      if (!failOp) continue

      for (const sizeObj of moduleDef.sizes) {
        const size = sizeObj.name

        const preferences = {
          preset: 'custom',
          modules: catalog.modules.map((m: { id: string; default_size: string }) => ({
            id: m.id,
            enabled: m.id === moduleDef.id,
            size: m.id === moduleDef.id ? size : m.default_size,
          })),
          pinned_device_ids: [],
          theme: 'system',
          density: 'compact',
        }

        await page.evaluate(
          async ({ prefs, token }) => {
            const res = await fetch('/admin/api/v1/me/preferences', {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token,
              },
              body: JSON.stringify(prefs),
            })
            if (!res.ok) throw new Error(`Failed to set preferences: ${res.status}`)
          },
          { prefs: preferences, token: csrfToken },
        )

        await page.goto(`/?mock-fail=${failOp}`)
        await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

        const targetModule = page.locator(`[data-module-id="${moduleDef.id}"]`)
        await expect(targetModule).toBeVisible()

        const card = targetModule.locator('[data-slot="dashboard-module-card"]')
        await expect(card).toBeVisible()

        const retryButton = card.getByRole('button', { name: 'Try again' })
        await expect(retryButton).toBeVisible()

        const content = card.locator('[data-slot="card-content"]')
        const metrics = await content.evaluate((el) => ({
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        }))
        expect(
          metrics.scrollHeight,
          `Error state in ${moduleDef.id} at ${size} scrollHeight exceeds clientHeight`,
        ).toBeLessThanOrEqual(metrics.clientHeight + 1)
        expect(
          metrics.scrollWidth,
          `Error state in ${moduleDef.id} at ${size} scrollWidth exceeds clientWidth`,
        ).toBeLessThanOrEqual(metrics.clientWidth + 1)
      }
    }
  })
})
