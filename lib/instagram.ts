import crypto from 'crypto';
import { db } from './db';

const GRAPH = 'https://graph.instagram.com/v23.0';

async function token() {
  const { data } = await db().from('credenciales').select('valor').eq('clave', 'instagram_token').maybeSingle();
  const t = data?.valor || process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!t) throw new Error('Falta el token de Instagram.');
  return t;
}

export async function instagramConectado() {
  try { return !!(await token()); } catch { return false; }
}

export function firmaValida(cuerpo: string, firma: string | null) {
  const secreto = process.env.INSTAGRAM_APP_SECRET;
  if (!secreto || !firma) return false;
  const esperado = 'sha256=' + crypto.createHmac('sha256', secreto).update(cuerpo).digest('hex');
  const a = Buffer.from(esperado), b = Buffer.from(firma);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function enviarDM(destinatario: string, texto: string): Promise<string[]> {
  const t = await token();
  const ids: string[] = [];
  const partes = texto.match(/[\s\S]{1,950}/g) ?? [texto]; // Instagram corta en 1000 caracteres
  for (const parte of partes) {
    const r = await fetch(`${GRAPH}/me/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify({ recipient: { id: destinatario }, message: { text: parte } }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Instagram rechazó el mensaje: ${d?.error?.message || r.status}`);
    if (d.message_id) ids.push(d.message_id);
  }
  return ids;
}

export async function nombreDe(igUsuario: string) {
  try {
    const r = await fetch(`${GRAPH}/${igUsuario}?fields=name,username`, { headers: { Authorization: `Bearer ${await token()}` } });
    const d = await r.json();
    return d.name || (d.username ? `@${d.username}` : '');
  } catch { return ''; }
}

// El token largo de Instagram dura 60 días: lo renovamos cada semana.
export async function renovarToken() {
  const t = await token();
  const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(t)}`);
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error(d?.error?.message || 'No se pudo renovar el token de Instagram.');
  await db().from('credenciales').upsert({ clave: 'instagram_token', valor: d.access_token, actualizado: new Date().toISOString() });
}
