import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDownIcon, ChevronUpIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import type { components } from '@/api/schema'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { queryKeys } from '@/lib/queryKeys'

type Group = components['schemas']['Group']
type GroupRule = components['schemas']['GroupRule']
type GroupRulePreview = components['schemas']['GroupRulePreview']
type RuleDeviceRef = components['schemas']['RuleDeviceRef']
type GroupRef = components['schemas']['GroupRef']

const PATTERN_REGEX = /^[a-zA-Z0-9.*_?-]+$/

export interface GroupRulesSectionProps {
  group: Group
  rules: GroupRule[]
}

export function GroupRulesSection({ group, rules }: GroupRulesSectionProps) {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [patternInput, setPatternInput] = React.useState('')
  const [debouncedPattern, setDebouncedPattern] = React.useState('')
  const [serverError, setServerError] = React.useState<string | null>(null)
  const [showMatches, setShowMatches] = React.useState(false)
  const [showConflicts, setShowConflicts] = React.useState(false)

  // Debounce input by >= 300 ms
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedPattern(patternInput.trim())
    }, 300)
    return () => clearTimeout(timer)
  }, [patternInput])

  const trimmedInput = patternInput.trim()
  const isInputNonEmpty = trimmedInput.length > 0
  const isValidSyntax = PATTERN_REGEX.test(trimmedInput)

  const validationError = !isInputNonEmpty
    ? null
    : trimmedInput.length > 128
      ? 'Pattern must be 128 characters or fewer.'
      : !isValidSyntax
        ? 'Pattern may only contain letters, numbers, and . _ * ? -'
        : null

  const shouldFetchPreview =
    Boolean(debouncedPattern) && debouncedPattern === trimmedInput && !validationError

  const previewQuery = useQuery<GroupRulePreview>({
    queryKey: ['groups', group.id, 'rules', 'preview', debouncedPattern],
    queryFn: () =>
      unwrap(
        api.POST('/admin/api/v1/groups/{id}/rules/preview', {
          params: { path: { id: group.id } },
          body: { pattern: debouncedPattern },
        }),
      ),
    enabled: shouldFetchPreview,
  })

  const preview = shouldFetchPreview ? (previewQuery.data ?? null) : null
  const isPreviewLoading = shouldFetchPreview && previewQuery.isLoading

  const previewError = previewQuery.error ? describeError(previewQuery.error).message : null
  const displayError = validationError ?? serverError ?? previewError

  // Add rule mutation
  const addMutation = useMutation({
    mutationFn: (pattern: string) =>
      unwrap(
        api.POST('/admin/api/v1/groups/{id}/rules', {
          params: { path: { id: group.id } },
          body: { pattern },
        }),
      ),
    onSuccess: (newRule: GroupRule) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.groupRules() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups() })
      toast({
        title: 'Rule added',
        description: `Pattern "${newRule.pattern}" attached to ${group.name}.`,
      })
      setPatternInput('')
      setDebouncedPattern('')
      setServerError(null)
    },
    onError: (err) => {
      const desc = describeError(err)
      if (desc.code === 'pattern_taken') {
        setServerError('This pattern already exists in this group.')
      } else {
        setServerError(desc.message)
      }
    },
  })

  // Remove rule mutation
  const removeMutation = useMutation({
    mutationFn: (ruleId: string) =>
      unwrap(
        api.DELETE('/admin/api/v1/groups/{id}/rules/{rule_id}', {
          params: { path: { id: group.id, rule_id: ruleId } },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.groupRules() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups() })
      toast({
        title: 'Rule removed',
        description: 'Pattern removed from group.',
      })
    },
    onError: (err) => {
      toast({
        title: 'Could not remove rule',
        description: describeError(err).message,
        variant: 'destructive',
      })
    },
  })

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPatternInput(e.target.value)
    setServerError(null)
  }

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    if (!trimmedInput || !isValidSyntax || addMutation.isPending) return
    addMutation.mutate(trimmedInput)
  }

  const isLimitReached = rules.length >= 20
  const pendingCount = preview
    ? preview.matches.filter((m: RuleDeviceRef) => m.state === 'pending').length
    : 0

  return (
    <div
      data-slot="group-rules-section"
      className="flex flex-col gap-3 p-3 mt-1 rounded-md border border-border/60 bg-muted/20 text-xs"
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold text-foreground">Auto-Sort Rules</span>
        <span className="text-2xs text-muted-foreground font-mono">{rules.length}/20 patterns</span>
      </div>

      <p className="text-2xs text-muted-foreground">
        * matches any characters, ? one character. Patterns match the whole device name (hostname),
        ignoring case.
      </p>

      {/* Existing Rules List */}
      {rules.length === 0 ? (
        <span className="text-muted-foreground italic text-2xs">No hostname patterns yet.</span>
      ) : (
        <div className="flex flex-wrap gap-1.5" data-slot="rules-list">
          {rules.map((rule: GroupRule) => (
            <Badge
              key={rule.id}
              variant="secondary"
              className="font-mono text-2xs py-0.5 pl-2 pr-1 gap-1.5 inline-flex items-center"
            >
              <span>{rule.pattern}</span>
              <button
                type="button"
                onClick={() => removeMutation.mutate(rule.id)}
                disabled={removeMutation.isPending}
                aria-label={`Remove pattern ${rule.pattern}`}
                className="text-muted-foreground hover:text-destructive cursor-pointer rounded-xs p-1 transition-colors focus-visible:outline-hidden min-h-[32px] min-w-[32px] sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center"
              >
                <Trash2Icon className="size-3.5 sm:size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {/* Add Pattern Field & Preview */}
      {!isLimitReached ? (
        <form onSubmit={handleAdd} className="flex flex-col gap-2 mt-1">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Input
                value={patternInput}
                onChange={handleInputChange}
                placeholder="e.g. w-*-it-*"
                aria-label={`Add pattern for ${group.name}`}
                aria-invalid={Boolean(displayError)}
                aria-describedby={displayError ? `rule-error-${group.id}` : undefined}
                className="h-11 sm:h-7 text-xs font-mono"
                maxLength={128}
                disabled={addMutation.isPending}
              />
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={!trimmedInput || !isValidSyntax || addMutation.isPending}
              className="h-11 sm:h-7 min-h-[44px] sm:min-h-0 px-3 sm:px-2 text-xs gap-1"
            >
              <PlusIcon className="size-3.5 sm:size-3" />
              <span>Add</span>
            </Button>
          </div>

          {/* Error Message */}
          {displayError && (
            <p id={`rule-error-${group.id}`} role="alert" className="text-2xs text-destructive">
              {displayError}
            </p>
          )}

          {/* Live Preview Information */}
          {isPreviewLoading && (
            <span className="text-2xs text-muted-foreground italic">Checking preview…</span>
          )}

          {!isPreviewLoading && preview && (
            <div className="flex flex-col gap-1.5 text-2xs text-muted-foreground bg-background/60 p-2 rounded border border-border/40">
              <div className="flex items-center justify-between font-medium text-foreground flex-wrap gap-2">
                <span>
                  Matches {preview.match_count} {preview.match_count === 1 ? 'device' : 'devices'} (
                  {pendingCount} pending)
                  {preview.conflict_count > 0 &&
                    ` · ${preview.conflict_count} ${preview.conflict_count === 1 ? 'conflict' : 'conflicts'}`}
                </span>

                <div className="flex items-center gap-2">
                  {preview.matches.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowMatches((prev) => !prev)}
                      className="text-primary hover:underline cursor-pointer inline-flex items-center gap-0.5"
                    >
                      <span>{showMatches ? 'Hide matches' : 'Show matches'}</span>
                      {showMatches ? (
                        <ChevronUpIcon className="size-3" />
                      ) : (
                        <ChevronDownIcon className="size-3" />
                      )}
                    </button>
                  )}
                  {preview.conflicts.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowConflicts((prev) => !prev)}
                      className="text-status-alert hover:underline cursor-pointer inline-flex items-center gap-0.5 font-medium"
                    >
                      <span>{showConflicts ? 'Hide conflicts' : 'Show conflicts'}</span>
                      {showConflicts ? (
                        <ChevronUpIcon className="size-3" />
                      ) : (
                        <ChevronDownIcon className="size-3" />
                      )}
                    </button>
                  )}
                </div>
              </div>

              {/* Expandable Matches List */}
              {showMatches && preview.matches.length > 0 && (
                <div className="flex flex-col gap-1 pt-1 border-t border-border/30 max-h-36 overflow-y-auto">
                  <span className="font-semibold text-foreground text-2xs">Matching devices:</span>
                  {preview.matches.map((m: RuleDeviceRef) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between font-mono text-2xs py-0.5 gap-2"
                    >
                      <span className="truncate flex-1 min-w-0">{m.hostname || m.rustdesk_id}</span>
                      <Badge variant="outline" className="text-2xs py-0 px-1 font-sans shrink-0">
                        {m.state}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}

              {/* Expandable Conflicts List */}
              {showConflicts && preview.conflicts.length > 0 && (
                <div className="flex flex-col gap-1 pt-1 border-t border-border/30 max-h-36 overflow-y-auto">
                  <span className="font-semibold text-status-alert text-2xs">
                    Conflicting devices:
                  </span>
                  {preview.conflicts.map((c: { device: RuleDeviceRef; groups: GroupRef[] }) => (
                    <div key={c.device.id} className="flex flex-col font-mono text-2xs py-0.5">
                      <span className="text-foreground truncate">
                        {c.device.hostname || c.device.rustdesk_id}
                      </span>
                      <span className="text-muted-foreground font-sans break-words">
                        Also matches: {c.groups.map((g: GroupRef) => g.name).join(', ')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </form>
      ) : (
        <span className="text-2xs text-muted-foreground italic">
          Maximum of 20 patterns reached for this group.
        </span>
      )}
    </div>
  )
}
