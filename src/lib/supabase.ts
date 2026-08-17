import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!url || !key) {
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY. ' +
      'Copy .env.example to .env.local for local dev, or set the repository ' +
      'variables for the GitHub Pages build.',
  )
}

export const supabase = createClient(url, key, {
  auth: {
    // Persisted so a phone lock, an accidental refresh or a tab switch mid-duel
    // drops you back into the same room as the same player.
    persistSession: true,
    autoRefreshToken: true,
    storageKey: 'betquiz.auth',
  },
  realtime: { params: { eventsPerSecond: 20 } },
})

/**
 * Everyone plays anonymously -- there is no signup. Each device still gets a
 * real Supabase identity, which is what the RLS policies key off.
 *
 * The stored session is verified against the server rather than trusted
 * blindly. getSession() only reads localStorage, so a JWT can look perfectly
 * valid -- correct signature, not expired -- while the user row behind it has
 * been deleted server-side. auth.uid() then returns an id that no longer
 * exists in auth.users, and every insert dies on a foreign key constraint
 * ("players_user_id_fkey") with nothing in the UI explaining why. getUser()
 * makes a real request, so a deleted or invalidated account is caught here and
 * healed by signing in fresh.
 */
export async function ensureSignedIn(): Promise<string> {
  const { data } = await supabase.auth.getSession()

  if (data.session?.user) {
    const { data: verified, error } = await supabase.auth.getUser()
    if (!error && verified.user) return verified.user.id
    await clearStaleSession()
  }

  return signInFresh()
}

/** Drop a session the server has rejected. Local-only: a server-side sign-out
 *  would itself fail on an account that no longer exists. */
async function clearStaleSession(): Promise<void> {
  try {
    await supabase.auth.signOut({ scope: 'local' })
  } catch {
    /* already unusable -- nothing to preserve */
  }
}

async function signInFresh(): Promise<string> {
  const { data, error } = await supabase.auth.signInAnonymously()
  if (error) throw error
  if (!data.user) throw new Error('anonymous sign-in returned no user')
  return data.user.id
}

/** True when a Postgres error means "my JWT points at a user that no longer
 *  exists" -- the signature of a session that outlived its account. */
export function isStaleSessionError(message: string): boolean {
  return /players_user_id_fkey|rooms_owner_id_fkey|violates foreign key constraint/i.test(message)
}

/** Re-authenticate after a stale session is detected mid-flight. Returns the
 *  new user id; the caller is a different identity afterwards. */
export async function recoverStaleSession(): Promise<string> {
  await clearStaleSession()
  return signInFresh()
}
