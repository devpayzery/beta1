import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseEnv } from '@/lib/server-env'

let adminClient: SupabaseClient | undefined
export function createAdminClient(): SupabaseClient {
  if (adminClient) return adminClient
  const env = getSupabaseEnv()
  adminClient = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  return adminClient
}
