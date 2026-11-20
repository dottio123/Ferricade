import * as React from 'react'
import { cn } from '@/lib/utils'
import {
  F_INK_PATH,
  F_TIP_FLAT_PATH,
  F_TIP_OXIDE_PATHS,
  F_TIP_RUST_CLIP_PATH,
  OXIDE_CLASS,
  WORDMARK_INK_PATHS,
  WORDMARK_POINTER_FLAT_PATH,
  WORDMARK_PTR_FLAKE_PATH,
  WORDMARK_PTR_OXIDE_PATHS,
  WORDMARK_PTR_RUST_CLIP_PATH,
} from './paths'

export interface WordmarkProps extends Omit<React.SVGProps<SVGSVGElement>, 'children'> {
  variant?: 'flat' | 'rust'
  decorative?: boolean
}

/** Ferricade wordmark. Ink follows each palette's --brand-ink token; rust tip & pointer keep brand rust. */
export function Wordmark({
  variant = 'flat',
  decorative = false,
  className,
  ...props
}: WordmarkProps) {
  const tipClipId = React.useId()
  const ptrClipId = React.useId()
  const a11yProps = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img' as const, 'aria-label': 'Ferricade' }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="-2 -39 1278 219"
      data-slot="brand-wordmark"
      data-brand-logo="wordmark"
      data-brand-variant={variant}
      className={cn('text-brand-ink shrink-0', className)}
      {...a11yProps}
      {...props}
    >
      <path data-brand-part="ink" className="fc-logo-ink" d={F_INK_PATH} />
      {WORDMARK_INK_PATHS.map((d, index) => (
        <path key={index} data-brand-part="ink" className="fc-logo-ink" d={d} />
      ))}
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
            <clipPath id={ptrClipId}>
              <path d={WORDMARK_PTR_RUST_CLIP_PATH} />
            </clipPath>
            <path className={OXIDE_CLASS.rim} d={WORDMARK_PTR_RUST_CLIP_PATH} />
            <g clipPath={`url(#${ptrClipId})`}>
              {WORDMARK_PTR_OXIDE_PATHS.map((layer, index) => (
                <path key={index} className={OXIDE_CLASS[layer.tone]} d={layer.d} />
              ))}
            </g>
            <path className={OXIDE_CLASS.flake} d={WORDMARK_PTR_FLAKE_PATH} />
          </g>
          <g data-brand-part="rust-fallback" className="fc-logo-flat-fallback">
            <path data-brand-part="rust" className="fc-logo-rust" d={F_TIP_FLAT_PATH} />
            <path data-brand-part="rust" className="fc-logo-rust" d={WORDMARK_POINTER_FLAT_PATH} />
          </g>
        </>
      ) : (
        <>
          <path data-brand-part="rust" className="fc-logo-rust" d={F_TIP_FLAT_PATH} />
          <path data-brand-part="rust" className="fc-logo-rust" d={WORDMARK_POINTER_FLAT_PATH} />
        </>
      )}
    </svg>
  )
}
