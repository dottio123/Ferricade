import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowLeftIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface PageHeaderProps {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
  backLink?: {
    to: string
    label?: string
  }
  className?: string
}

export function PageHeader({ title, description, actions, backLink, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {backLink && (
        <div>
          <Link
            to={backLink.to}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-1"
          >
            <ArrowLeftIcon className="size-3.5" />
            <span>{backLink.label ?? 'Back'}</span>
          </Link>
        </div>
      )}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-foreground truncate">{title}</h1>
          {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  )
}
