import * as React from 'react'
import {
  F_INK_PATH,
  F_TIP_FLAT_PATH,
  F_TIP_OXIDE_PATHS,
  F_TIP_RUST_CLIP_PATH,
  type OxideTone,
} from '@/components/brand/paths'
import { cn } from '@/lib/utils'

const KIT_OXIDE_CLASS: Record<OxideTone, string> = {
  rim: 'r-rim',
  face: 'r-face',
  warm: 'r-warm',
  bright: 'r-bright',
  dark: 'r-dark',
  pit: 'r-pit',
  flake: 'r-flake',
}

export interface FerricadeLoaderProps {
  fullPage?: boolean
  className?: string
}

/** Full-page F loader for initial app boot and whole-page route waits. */
export function FerricadeLoader({ fullPage = false, className }: FerricadeLoaderProps) {
  const uid = React.useId()
  const maskIds = [`${uid}-m1`, `${uid}-m2`, `${uid}-m3`] as const
  const tipClipId = `${uid}-tipc`

  return (
    <div
      role="status"
      aria-label="Loading"
      data-slot="brand-loader"
      className={cn(
        'flex items-center justify-center bg-background',
        fullPage ? 'fixed inset-0 z-50 min-h-screen w-full' : 'min-h-full w-full flex-1 p-6',
        className,
      )}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="fx h-auto w-36 sm:w-44"
        viewBox="-112.18 -81.97 340 340"
        aria-hidden="true"
      >
        <defs>
          {maskIds.map((maskId, idx) => (
            <mask
              key={maskId}
              id={maskId}
              maskUnits="userSpaceOnUse"
              x="-130"
              y="-110"
              width="380"
              height="400"
            >
              <path className={`fl-w d${idx + 1}`} d={F_INK_PATH} />
              <path className={`fl-b d${idx + 1}`} d={F_INK_PATH} />
              <path d={F_INK_PATH} fill="#000" />
            </mask>
          ))}
        </defs>
        {maskIds.map((maskId, idx) => (
          <rect
            key={maskId}
            className={`fx-ring fl-ring d${idx + 1}`}
            mask={`url(#${maskId})`}
            x="-130"
            y="-110"
            width="380"
            height="400"
          />
        ))}
        <path className="fx-ink" d={F_INK_PATH} />
        <clipPath id={tipClipId}>
          <path d={F_TIP_RUST_CLIP_PATH} />
        </clipPath>
        <path className="r-rim" d={F_TIP_RUST_CLIP_PATH} />
        <g clipPath={`url(#${tipClipId})`}>
          {F_TIP_OXIDE_PATHS.map((layer, index) => (
            <path key={index} className={KIT_OXIDE_CLASS[layer.tone]} d={layer.d} />
          ))}
        </g>
        <path className="fl-glow" d={F_TIP_FLAT_PATH} />
      </svg>
    </div>
  )
}
