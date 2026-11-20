import * as React from 'react'
import {
  F_INK_PATH,
  F_TIP_FLAT_PATH,
  F_TIP_OXIDE_PATHS,
  F_TIP_RUST_CLIP_PATH,
  type OxideTone,
  WORDMARK_INK_PATHS,
  WORDMARK_POINTER_FLAT_PATH,
  WORDMARK_PTR_FLAKE_PATH,
  WORDMARK_PTR_OXIDE_PATHS,
  WORDMARK_PTR_RUST_CLIP_PATH,
} from '@/components/brand/paths'

const KIT_OXIDE_CLASS: Record<OxideTone, string> = {
  rim: 'r-rim',
  face: 'r-face',
  warm: 'r-warm',
  bright: 'r-bright',
  dark: 'r-dark',
  pit: 'r-pit',
  flake: 'r-flake',
}

const INTRO_DURATION_MS = 5100
const REDUCED_MOTION_DURATION_MS = 1100
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta'])

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export interface FerricadeIntroProps {
  onComplete: () => void
}

/** Full-page brand intro played once after sign-in. Click or any key skips without shifting focus. */
export function FerricadeIntro({ onComplete }: FerricadeIntroProps) {
  const uid = React.useId()
  const maskIds = [`${uid}-m1`, `${uid}-m2`, `${uid}-m3`] as const
  const tipClipId = `${uid}-tipc`
  const ptrClipId = `${uid}-pfc`

  const onCompleteRef = React.useRef(onComplete)
  React.useEffect(() => {
    onCompleteRef.current = onComplete
  })

  const doneRef = React.useRef(false)
  const finish = React.useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    onCompleteRef.current()
  }, [])

  React.useEffect(() => {
    const duration = prefersReducedMotion() ? REDUCED_MOTION_DURATION_MS : INTRO_DURATION_MS
    const timer = window.setTimeout(finish, duration)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (MODIFIER_KEYS.has(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      finish()
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [finish])

  return (
    <div
      data-slot="brand-intro"
      onClick={(event) => {
        event.stopPropagation()
        finish()
      }}
      className="fixed inset-0 z-[110] flex items-center justify-center bg-background p-6 sm:p-10 select-none"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="fx h-auto w-full max-w-4xl"
        viewBox="-110 -230 1494 636"
        role="img"
        aria-label="Ferricade"
      >
        <g className="fi-f">
          <defs>
            {maskIds.map((maskId, idx) => (
              <mask
                key={maskId}
                id={maskId}
                maskUnits="userSpaceOnUse"
                x="-130"
                y="-130"
                width="380"
                height="440"
              >
                <path className={`fi-w d${idx + 1}`} d={F_INK_PATH} />
                <path className={`fi-b d${idx + 1}`} d={F_INK_PATH} />
                <path d={F_INK_PATH} fill="#000" />
              </mask>
            ))}
          </defs>
          {maskIds.map((maskId, idx) => (
            <rect
              key={maskId}
              className={`fx-ring fi-ring d${idx + 1}`}
              mask={`url(#${maskId})`}
              x="-130"
              y="-130"
              width="380"
              height="440"
            />
          ))}
          <path className="fx-ink fi-body" d={F_INK_PATH} />
          <g className="fi-tip">
            <clipPath id={tipClipId}>
              <path d={F_TIP_RUST_CLIP_PATH} />
            </clipPath>
            <path className="r-rim" d={F_TIP_RUST_CLIP_PATH} />
            <g clipPath={`url(#${tipClipId})`}>
              {F_TIP_OXIDE_PATHS.map((layer, index) => (
                <path key={index} className={KIT_OXIDE_CLASS[layer.tone]} d={layer.d} />
              ))}
            </g>
          </g>
          <path className="fi-glow" d={F_TIP_FLAT_PATH} />
        </g>
        {WORDMARK_INK_PATHS.map((d, index) => (
          <path key={index} className={`fx-ink fi-l l${index}`} d={d} />
        ))}
        <circle className="fi-rip r1" cx="613.15" cy="-31.63" r="10" />
        <circle className="fi-rip r2" cx="613.15" cy="-31.63" r="10" />
        <g className="fi-p">
          <clipPath id={ptrClipId}>
            <path d={WORDMARK_PTR_RUST_CLIP_PATH} />
          </clipPath>
          <path className="r-rim" d={WORDMARK_PTR_RUST_CLIP_PATH} />
          <g clipPath={`url(#${ptrClipId})`}>
            {WORDMARK_PTR_OXIDE_PATHS.map((layer, index) => (
              <path key={index} className={KIT_OXIDE_CLASS[layer.tone]} d={layer.d} />
            ))}
          </g>
          <path className="r-flake" d={WORDMARK_PTR_FLAKE_PATH} />
          <path className="fi-flash" d={WORDMARK_POINTER_FLAT_PATH} />
        </g>
      </svg>
    </div>
  )
}
