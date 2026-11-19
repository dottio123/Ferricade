import type { MockSize } from '../config'
import type { User } from './types'

export const OWNER_ID = '5d1c3a52-8f0e-4c1b-9a51-2f0b6f3f6a01'
export const ADMIN_ID = '7e2d4b63-9a1f-4d2c-8b62-3a1c7a4a7b02'
export const HELPDESK_ID = 'a15f7e96-2d4c-4a5b-9e95-6d4fab7da105'

export function createUsers(size: MockSize): User[] {
  const users: User[] = [
    {
      id: OWNER_ID,
      username: 'alex',
      display_name: 'Alex Rivera',
      email: 'alex@example.com',
      role: 'owner',
      status: 'active',
      totp_required: true,
      sso: false,
      avatar_url: null,
    },
    {
      id: ADMIN_ID,
      username: 'sam',
      display_name: 'Sam Okafor',
      email: 'sam@example.com',
      role: 'admin',
      status: 'active',
      totp_required: true,
      sso: false,
      avatar_url: null,
    },
    {
      id: HELPDESK_ID,
      username: 'helpdesk',
      display_name: 'Helpdesk',
      email: 'helpdesk@example.com',
      role: 'user',
      status: 'active',
      totp_required: false,
      sso: false,
      avatar_url: null,
    },
  ]
  if (size !== 'small') {
    users.push(
      {
        id: '8f3e5c74-0b2a-4e3d-9c73-4b2d8b5b8c03',
        username: 'jordan',
        display_name: 'Jordan Lee',
        email: 'jordan@example.com',
        role: 'admin',
        status: 'active',
        totp_required: false,
        sso: false,
        avatar_url: null,
      },
      {
        id: '904f6d85-1c3b-4f4e-8d84-5c3e9c6c9d04',
        username: 'casey',
        display_name: 'Casey Nguyen',
        email: 'casey@example.com',
        role: 'admin',
        status: 'disabled',
        totp_required: true,
        sso: false,
        avatar_url: null,
      },
    )
  }
  return users
}
