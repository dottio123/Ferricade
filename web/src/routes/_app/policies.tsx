import { createFileRoute } from '@tanstack/react-router'
import { PoliciesView } from '@/components/settings/policies-view'

export type PoliciesSearch = {
  edit?: string
}

function validatePoliciesSearch(search: Record<string, unknown>): PoliciesSearch {
  const result: PoliciesSearch = {}
  if (typeof search.edit === 'string' && search.edit) {
    result.edit = search.edit
  }
  return result
}

export const Route = createFileRoute('/_app/policies')({
  validateSearch: validatePoliciesSearch,
  component: PoliciesView,
})
