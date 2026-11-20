import { describe, expect, it } from 'vitest'
import { queryKeys } from './queryKeys'
import { groupsQueryOptions, preferencesQueryOptions, summaryQueryOptions } from './queries'

describe('shared query options', () => {
  it('uses the existing cache keys for summary, groups, and preferences', () => {
    expect(summaryQueryOptions.queryKey).toEqual(queryKeys.summary())
    expect(groupsQueryOptions.queryKey).toEqual(queryKeys.groups())
    expect(preferencesQueryOptions.queryKey).toEqual(queryKeys.preferences())
  })
})
