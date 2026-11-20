import * as React from 'react'
import { cn } from '@/lib/utils'
import {
  F_INK_PATH,
  F_TIP_FLAT_PATH,
  F_TIP_OXIDE_PATHS,
  F_TIP_RUST_CLIP_PATH,
  OXIDE_CLASS,
} from './paths'

export interface FMarkProps extends Omit<React.SVGProps<SVGSVGElement>, 'children'> {
  variant?: 'flat' | 'rust'
  decorative?: boolean
}

/** Ferricade corner-cut F mark. Ink follows each palette's --brand-ink token; rust tip keeps brand rust. */
export function FMark({ variant = 'flat', decorative = false, className, ...props }: FMarkProps) {
  const tipClipId = React.useId()
  const a11yProps = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img' as const, 'aria-label': 'Ferricade' }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="-2 -2 119.64 180.07"
      data-slot="brand-f-mark"
      data-brand-logo="f-mark"
      data-brand-variant={variant}
      className={cn('text-brand-ink shrink-0', className)}
      {...a11yProps}
      {...props}
    >
      <path data-brand-part="ink" className="fc-logo-ink" d={F_INK_PATH} />
      {variant === 'rust' ? (
        <>
          <g data-brand-part="rust-detail" className="fc-logo-rust-detail">
            <clipPath id={tipClipId}>
              <path d={F_TIP_RUST_CLIP_PATH} />
            </clipPath>
            <path className={OXIDE_CLASS.rim} d={F_TIP_RUST_CLIP_PATH} />
            <g clipPath={`url(#${tipClipId})`}>
              {F_TIP_OXIDE_PATHS.map((layer, index) => (
                <path key={index} className={OXIDE_CLASS[layer.tone]} d={layer.d} />
              ))}
            </g>
          </g>
          <g data-brand-part="rust-fallback" className="fc-logo-flat-fallback">
            <path data-brand-part="rust" className="fc-logo-rust" d={F_TIP_FLAT_PATH} />
          </g>
        </>
      ) : (
        <path data-brand-part="rust" className="fc-logo-rust" d={F_TIP_FLAT_PATH} />
      )}
    </svg>
  )
}
