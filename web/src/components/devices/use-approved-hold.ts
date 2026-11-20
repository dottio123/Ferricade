import * as React from 'react'
import type { components } from '@/api/schema'

type Device = components['schemas']['Device']

// Keep a just-approved card in its original slot until a second click cannot hit another Approve.
export function useApprovedHold() {
  const [held, setHeld] = React.useState<{ device: Device; index: number }[]>([])
  const timers = React.useRef<ReturnType<typeof setTimeout>[]>([])
  React.useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const hold = React.useCallback((device: Device, index: number) => {
    setHeld((previous) => [
      ...previous.filter((entry) => entry.device.id !== device.id),
      { device, index },
    ])
    timers.current.push(
      setTimeout(() => {
        setHeld((previous) => previous.filter((entry) => entry.device.id !== device.id))
      }, 2000),
    )
  }, [])

  const visible = React.useCallback(
    (pending: Device[]) => {
      const items = pending.filter((device) => !held.some((entry) => entry.device.id === device.id))
      for (const entry of [...held].sort((a, b) => a.index - b.index)) {
        items.splice(Math.max(0, Math.min(entry.index, items.length)), 0, entry.device)
      }
      return items
    },
    [held],
  )

  return { hold, visible, isHeld: (id: string) => held.some((entry) => entry.device.id === id) }
}
