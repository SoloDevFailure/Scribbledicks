import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

function isValidSupabaseUrl(value: string | undefined): value is string {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.endsWith('.supabase.co')
  } catch {
    return false
  }
}

export const supabaseConfigError = !supabaseUrl || !supabaseAnonKey
  ? 'Supabase configuration is missing.'
  : !isValidSupabaseUrl(supabaseUrl)
    ? 'VITE_SUPABASE_URL must be a valid https://….supabase.co URL.'
    : null

export const isSupabaseConfigured = supabaseConfigError === null

export const supabase = isSupabaseConfigured && isValidSupabaseUrl(supabaseUrl)
  ? createClient(supabaseUrl, supabaseAnonKey!, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 10 } },
    })
  : null
