import * as React from 'react'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'

export interface UseConnectLinkOptions {
  action?: 'connect' | 'file-transfer' | 'port-forward' | 'terminal'
  relay?: boolean
  /** False fetches the link without handing it to RustDesk (default true). */
  launch?: boolean
  onError?: (error: unknown) => void
}

export interface ConnectResult {
  url: string
  command: string
  includes_server: boolean
}

export function useConnectLink() {
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<ConnectResult | null>(null)
  // Opening the link box fetches without launching. It has its own progress and
  // error so a Connect click and the box do not show each other's.
  const [previewLoading, setPreviewLoading] = React.useState(false)
  const [previewError, setPreviewError] = React.useState<string | null>(null)
  const previewRef = React.useRef(0)
  // Every request, launching or not, takes a number; only the newest may write the result.
  const resultRef = React.useRef(0)

  const connect = React.useCallback(
    async (
      deviceId: string,
      options: UseConnectLinkOptions = {},
    ): Promise<ConnectResult | null> => {
      const launch = options.launch !== false
      // A newer preview fetch (action or relay changed) supersedes this one.
      const ticket = launch ? 0 : ++previewRef.current
      const stale = () => !launch && ticket !== previewRef.current
      const resultTicket = ++resultRef.current
      const superseded = () => resultTicket !== resultRef.current
      if (launch) {
        setIsLoading(true)
        setError(null)
      } else {
        setPreviewLoading(true)
        setPreviewError(null)
      }
      try {
        const res = await unwrap(
          api.GET('/admin/api/v1/devices/{id}/connect', {
            params: {
              path: { id: deviceId },
              query: {
                action: options.action ?? 'connect',
                relay: options.relay ? '1' : '0',
              },
            },
          }),
        )
        if (stale()) return null

        if (res.url.startsWith('rustdesk://')) {
          const next = { url: res.url, command: res.command, includes_server: res.includes_server }
          // A slow response must not replace the link of a newer request; a Connect still launches.
          if (!superseded()) setResult(next)
          if (launch) window.location.assign(res.url)
          return next
        } else {
          const msg = 'Invalid connection URL received from server.'
          if (launch) setError(msg)
          else setPreviewError(msg)
          return null
        }
      } catch (err) {
        if (stale()) return null
        const msg = describeError(err).message
        if (launch) setError(msg)
        else setPreviewError(msg)
        options.onError?.(err)
        return null
      } finally {
        if (launch) setIsLoading(false)
        else if (!stale()) setPreviewLoading(false)
      }
    },
    [],
  )

  const clearError = React.useCallback(() => {
    setError(null)
    setPreviewError(null)
  }, [])

  const clearResult = React.useCallback(() => {
    previewRef.current++
    resultRef.current++
    setResult(null)
    setPreviewLoading(false)
  }, [])

  return {
    connect,
    isLoading,
    error,
    result,
    previewLoading,
    previewError,
    clearError,
    clearResult,
  }
}
