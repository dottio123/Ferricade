import { CheckIcon, CircleDashedIcon, XIcon } from 'lucide-react'

export function passwordRulesMet(password: string, username: string, confirmation?: string) {
  return (
    [...password].length >= 12 &&
    (!username || password.toLowerCase() !== username.toLowerCase()) &&
    (confirmation === undefined || (password.length > 0 && password === confirmation))
  )
}

interface PasswordRulesProps {
  password: string
  username: string
  confirmation?: string
  usernameWording?: 'your' | 'the'
  weakPasswordMessage?: string | null
  id?: string
}

export function PasswordRules({
  password,
  username,
  confirmation,
  usernameWording = 'your',
  weakPasswordMessage,
  id,
}: PasswordRulesProps) {
  const lengthMet = [...password].length >= 12
  const usernameMet = !username || password.toLowerCase() !== username.toLowerCase()
  const matches = confirmation === undefined || (password.length > 0 && password === confirmation)

  return (
    <div id={id} className="flex flex-col gap-1 text-xs">
      <Rule met={lengthMet} label={`At least 12 characters (${[...password].length}/12)`} />
      <Rule met={usernameMet} label={`Not ${usernameWording} username, in any capitalisation`} />
      <div
        className={`flex items-center gap-1.5 transition-colors ${
          weakPasswordMessage ? 'text-destructive font-medium' : 'text-muted-foreground'
        }`}
      >
        {weakPasswordMessage ? (
          <XIcon className="size-3 shrink-0" aria-hidden="true" />
        ) : (
          <CircleDashedIcon className="size-3 shrink-0" aria-hidden="true" />
        )}
        <span>
          Not a commonly used password
          {!weakPasswordMessage && ' (checked when you save)'}
        </span>
        {weakPasswordMessage && <span className="sr-only">not met</span>}
        {weakPasswordMessage && (
          <span role="alert" className="text-destructive">
            {weakPasswordMessage}
          </span>
        )}
      </div>
      {confirmation !== undefined && <Rule met={matches} label="Passwords match" />}
    </div>
  )
}

export function Rule({ met, label }: { met: boolean; label: string }) {
  return (
    <div
      className={`flex items-center gap-1.5 transition-colors ${
        met ? 'text-status-online font-medium' : 'text-muted-foreground'
      }`}
    >
      {met ? (
        <CheckIcon className="size-3 shrink-0" aria-hidden="true" />
      ) : (
        <XIcon className="size-3 shrink-0" aria-hidden="true" />
      )}
      <span>{label}</span>
      <span className="sr-only">{met ? 'met' : 'not met'}</span>
    </div>
  )
}
