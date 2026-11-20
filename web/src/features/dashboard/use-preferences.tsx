import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { ToastAction, useToast } from '@/components/ui/toast'
import { queryKeys } from '@/lib/queryKeys'
import { preferencesQueryOptions } from '@/lib/queries'
import { PIN_LIMIT, reconcilePreferences, type Preferences } from './preferences'

function useDashboardCatalog() {
  return useQuery({
    queryKey: queryKeys.dashboardCatalog(),
    queryFn: ({ signal }) => unwrap(api.GET('/admin/api/v1/dashboard/catalog', { signal })),
  })
}

export function useRawPreferences() {
  return useQuery(preferencesQueryOptions)
}

export function useDashboardPreferences() {
  const catalogQuery = useDashboardCatalog()
  const preferencesQuery = useRawPreferences()

  const reconciled = React.useMemo(() => {
    if (!catalogQuery.data) return undefined
    return reconcilePreferences(catalogQuery.data, preferencesQuery.data)
  }, [catalogQuery.data, preferencesQuery.data])

  return {
    catalog: catalogQuery.data,
    preferences: reconciled,
    isLoading: catalogQuery.isLoading || preferencesQuery.isLoading,
    // A failed first load only: a failed refetch keeps the layout on screen.
    isLoadingError: catalogQuery.isLoadingError || preferencesQuery.isLoadingError,
    error: catalogQuery.error || preferencesQuery.error,
    refetch: () => {
      if (catalogQuery.isLoadingError) void catalogQuery.refetch()
      if (preferencesQuery.isLoadingError) void preferencesQuery.refetch()
    },
  }
}

export function useUpdatePreferences() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const mutation = useMutation({
    meta: { errorTitle: 'Could not save your preferences' },
    mutationFn: (body: Preferences) => unwrap(api.PUT('/admin/api/v1/me/preferences', { body })),
    onSuccess: (saved) => {
      // Set the query cache directly from the PUT response (no refetch)
      queryClient.setQueryData(queryKeys.preferences(), saved)
    },
  })

  const saveWithUndo = React.useCallback(
    (newPrefs: Preferences, previousPrefs: Preferences, onSaved?: () => void) => {
      mutation.mutate(newPrefs, {
        onSuccess: () => {
          onSaved?.()
          toast({
            title: 'Layout saved',
            action: (
              <ToastAction
                altText="Undo"
                onClick={() => {
                  mutation.mutate(previousPrefs, {
                    onSuccess: () => {
                      toast({ title: 'Layout restored' })
                    },
                  })
                }}
              >
                Undo
              </ToastAction>
            ),
          })
        },
      })
    },
    [mutation, toast],
  )

  const togglePin = React.useCallback(
    (deviceId: string) => {
      const current = queryClient.getQueryData<Preferences>(queryKeys.preferences())
      if (!current) return
      const isPinned = current.pinned_device_ids.includes(deviceId)
      if (!isPinned && current.pinned_device_ids.length >= PIN_LIMIT) {
        toast({
          title: `You can pin up to ${PIN_LIMIT} devices.`,
          variant: 'destructive',
        })
        return
      }

      const nextPinned = isPinned
        ? current.pinned_device_ids.filter((id) => id !== deviceId)
        : [...current.pinned_device_ids, deviceId]

      const nextPrefs: Preferences = {
        ...current,
        pinned_device_ids: nextPinned,
      }

      mutation.mutate(nextPrefs)
    },
    [mutation, queryClient, toast],
  )

  return {
    ...mutation,
    saveWithUndo,
    togglePin,
  }
}
