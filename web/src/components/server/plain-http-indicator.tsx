import { useEffect, useRef, useState } from 'react'
import { LockOpenIcon } from 'lucide-react'
import { usePlainHttp } from '../../auth/session'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

export const PLAIN_HTTP_NOTICE =
  'This console is served over plain HTTP. Sign-ins and session cookies are not encrypted on the network.'

export function PlainHttpIndicator() {
  const plainHttp = usePlainHttp()
  const [pinnedOpen, setPinnedOpen] = useState(false)
  const [hoverOpen, setHoverOpen] = useState(false)
  const [focusOpen, setFocusOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pointerDownRef = useRef(false)
  const hoverTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(hoverTimerRef.current), [])

  if (!plainHttp) return null

  const open = pinnedOpen || hoverOpen || focusOpen

  const clearHoverTimer = () => {
    window.clearTimeout(hoverTimerRef.current)
  }

  const scheduleHoverClose = () => {
    clearHoverTimer()
    hoverTimerRef.current = window.setTimeout(() => {
      setHoverOpen(false)
    }, 100)
  }

  const closeAll = () => {
    clearHoverTimer()
    setPinnedOpen(false)
    setHoverOpen(false)
    setFocusOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) closeAll()
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label="Plain HTTP connection"
          onPointerDown={() => {
            pointerDownRef.current = true
            window.setTimeout(() => {
              pointerDownRef.current = false
            }, 0)
          }}
          onPointerEnter={(event) => {
            if (event.pointerType !== 'mouse') return
            clearHoverTimer()
            setHoverOpen(true)
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== 'mouse') return
            scheduleHoverClose()
          }}
          onFocus={() => {
            if (!pointerDownRef.current) {
              setFocusOpen(true)
            }
          }}
          onBlur={(event) => {
            const related = event.relatedTarget as Node | null
            if (!contentRef.current?.contains(related)) {
              setFocusOpen(false)
            }
          }}
          onClick={() => {
            if (pinnedOpen) {
              closeAll()
            } else {
              setPinnedOpen(true)
            }
          }}
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors shrink-0 rounded-sm cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <LockOpenIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span>HTTP</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="end"
        aria-label="Plain HTTP notice"
        onOpenAutoFocus={(event) => {
          if (!pinnedOpen) event.preventDefault()
        }}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'mouse') return
          clearHoverTimer()
          setHoverOpen(true)
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== 'mouse') return
          scheduleHoverClose()
        }}
        onBlur={(event) => {
          const related = event.relatedTarget as Node | null
          if (!triggerRef.current?.contains(related) && !contentRef.current?.contains(related)) {
            setFocusOpen(false)
          }
        }}
        className="w-72 max-w-[calc(100vw-2rem)] p-3 text-xs leading-relaxed text-muted-foreground"
      >
        <p>{PLAIN_HTTP_NOTICE}</p>
      </PopoverContent>
    </Popover>
  )
}
