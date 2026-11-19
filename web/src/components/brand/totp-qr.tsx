import * as React from 'react'
import QRCode from 'qrcode'
import { cn } from '@/lib/utils'

export interface TotpQrProps extends React.SVGProps<SVGSVGElement> {
  otpauthUrl: string
  size?: number
}

export function TotpQr({ otpauthUrl, size = 192, className, ...props }: TotpQrProps) {
  const qr = React.useMemo(() => {
    try {
      return QRCode.create(otpauthUrl, { errorCorrectionLevel: 'M' })
    } catch {
      return null
    }
  }, [otpauthUrl])

  const path = React.useMemo(() => {
    if (!qr) return ''
    const { modules } = qr
    const count = modules.size
    let d = ''
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (modules.get(r, c)) {
          d += `M${c},${r}h1v1h-1z `
        }
      }
    }
    return d
  }, [qr])

  if (!qr) return null

  const count = qr.modules.size
  const totalSize = count + 8 // 4-module quiet zone margin on each side

  return (
    <div className="inline-flex rounded-lg border border-border bg-white p-2 shadow-xs">
      <svg
        role="img"
        aria-label="QR code for your authenticator app"
        viewBox={`-4 -4 ${totalSize} ${totalSize}`}
        width={size}
        height={size}
        className={cn('text-black', className)}
        {...props}
      >
        <rect x="-4" y="-4" width={totalSize} height={totalSize} fill="#ffffff" />
        <path d={path} fill="#000000" shapeRendering="crispEdges" />
      </svg>
    </div>
  )
}
