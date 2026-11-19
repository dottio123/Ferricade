export function oidcErrorMessage(code: string, displayName = 'your provider'): string {
  switch (code) {
    case 'not_allowed':
      return `Your account at ${displayName} is not in a group that may use Ferricade.`
    case 'no_account':
      return 'There is no Ferricade account for you, and new accounts are not created automatically. Ask an owner.'
    case 'account_conflict':
      return 'Your email matches a Ferricade account that cannot be linked automatically. Ask an owner.'
    case 'disabled':
      return 'Your Ferricade account is disabled. Ask an owner.'
    case 'expired':
      return 'Your sign-in took too long or was started again. Try again.'
    case 'rate_limited':
      return 'Too many sign-in attempts. Wait a minute and try again.'
    default:
      return `Signing in with ${displayName} did not work. Try again, or sign in with your password.`
  }
}
