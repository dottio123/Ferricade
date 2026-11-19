import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import { applyAppearance, type Palette, type Theme } from '@/lib/appearance'
import type { components } from '@/api/schema'
import { queryKeys } from '@/lib/queryKeys'
import { preferencesQueryOptions } from '@/lib/queries'
type Preferences = components['schemas']['Preferences']
type AppearanceChange = Partial<Pick<Preferences, 'theme' | 'palette' | 'toast_seconds'>>

export function useThemeSwitch() {
  const queryClient = useQueryClient()
  const [themeError, setThemeError] = React.useState<string | null>(null)

  const {
    data: preferences,
    isLoading,
    error: preferencesError,
    refetch,
  } = useQuery(preferencesQueryOptions)

  // Apply server appearance once preferences have loaded
  React.useEffect(() => {
    if (preferences) {
      applyAppearance({
        theme: preferences.theme,
        palette: preferences.palette,
        density: preferences.density,
      })
    }
  }, [preferences])

  const updateThemeMutation = useMutation({
    scope: { id: 'preferences' },
    mutationFn: (change: AppearanceChange) => {
      const current = queryClient.getQueryData<Preferences>(queryKeys.preferences())
      if (!current) throw new Error('Preferences not loaded')
      const body = { ...current, ...change }
      return unwrap(api.PUT('/admin/api/v1/me/preferences', { body }))
    },
    onMutate: async (change) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.preferences() })
      setThemeError(null)
      const prev = queryClient.getQueryData<Preferences>(queryKeys.preferences())
      if (prev) {
        const next = { ...prev, ...change }
        queryClient.setQueryData(queryKeys.preferences(), next)
        applyAppearance({ theme: next.theme, palette: next.palette, density: next.density })
      }
      return { prev }
    },
    onError: (err, _newTheme, context) => {
      if (context?.prev) {
        queryClient.setQueryData(queryKeys.preferences(), context.prev)
        applyAppearance({
          theme: context.prev.theme,
          palette: context.prev.palette,
          density: context.prev.density,
        })
      }
      setThemeError(describeError(err).message)
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.preferences(), saved)
      applyAppearance({ theme: saved.theme, palette: saved.palette, density: saved.density })
    },
  })

  const currentTheme: Theme = preferences?.theme ?? 'system'

  const cycleTheme = React.useCallback(() => {
    // Cycle: dark → light → system → dark
    const nextTheme: Theme =
      currentTheme === 'dark' ? 'light' : currentTheme === 'light' ? 'system' : 'dark'
    updateThemeMutation.mutate({ theme: nextTheme })
  }, [currentTheme, updateThemeMutation])

  const setTheme = React.useCallback(
    (theme: Theme) => {
      updateThemeMutation.mutate({ theme })
    },
    [updateThemeMutation],
  )

  const setPalette = React.useCallback(
    (palette: Palette) => updateThemeMutation.mutate({ palette }),
    [updateThemeMutation],
  )

  const setToastSeconds = React.useCallback(
    (toast_seconds: Preferences['toast_seconds']) => updateThemeMutation.mutate({ toast_seconds }),
    [updateThemeMutation],
  )

  return {
    theme: currentTheme,
    palette: preferences?.palette ?? 'default',
    toastSeconds: preferences?.toast_seconds ?? 5,
    density: preferences?.density ?? 'comfortable',
    setTheme,
    setPalette,
    setToastSeconds,
    cycleTheme,
    isLoading,
    preferencesError,
    refetchPreferences: refetch,
    isPending: updateThemeMutation.isPending,
    error: themeError,
  }
}
