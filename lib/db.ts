import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en las variables de entorno.');
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

export const AGENTES_IDS = ['arthur', 'eleanor', 'margaret', 'julian', 'theo', 'henry', 'victoria', 'oliver'] as const;
export type AgenteId = (typeof AGENTES_IDS)[number];

export async function setAhora(agente: AgenteId, ahora: string, estado?: 'ok' | 'wait' | 'idle') {
  const cambios: Record<string, unknown> = { ahora, actualizado: new Date().toISOString() };
  if (estado) cambios.estado = estado;
  await db().from('agentes').update(cambios).eq('id', agente);
}
