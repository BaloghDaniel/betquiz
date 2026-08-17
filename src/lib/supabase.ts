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
 */
export async function ensureSignedIn(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  if (data.session?.user) return data.session.user.id

  const { data: signed, error } = await supabase.auth.signInAnonymously()
  if (error) throw error
  if (!signed.user) throw new Error('anonymous sign-in returned no user')
  return signed.user.id
}
