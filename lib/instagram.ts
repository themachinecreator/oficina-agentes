import crypto from 'crypto';
import { db } from './db';

const IG_GRAPH = 'https://graph.instagram.com/v23.0';
const FB_GRAPH = 'https://graph.facebook.com/v23.0';
const IG_ID = process.env.INSTAGRAM_ACCOUNT_ID || '17841447907774982';

// Tokens de "inicio de sesión con Instagram" empiezan con IGAA y van a graph.instagram.com.
// Los de inicio de sesión unificado / usuario del sistema (EAA…) van a graph.facebook.com con el id de la cuenta.
function rutas(t: string) {
  return t.startsWith('IG')
    ? { base: IG_GRAPH, mensajes: `${IG_GRAPH}/me/messages` }
    : { base: FB_GRAPH, mensajes: `${FB_GRAPH}/${IG_ID}/messages` };
}

async function token() {
  const { data } = await db().from('credenciales').select('valor').eq('clave', 'instagram_token').maybeSingle();
  const t = data?.valor || process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!t) throw new Error('Falta el token de Instagram.');
  return t;
}

export async function instagramConectado() {
  try { return !!(await token()); } catch { return false; }
}

// Meta firma los webhooks con la clave de la app de Instagram o con la de la app de Meta, según la configuración.
export function firmaValida(cuerpo: string, firma: string | null) {
  if (!firma) return false;
  const secretos = [process.env.INSTAGRAM_APP_SECRET, process.env.META_APP_SECRET].filter(Boolean) as string[];
  return secretos.some((secreto) => {
    const esperado = 'sha256=' + crypto.createHmac('sha256', secreto).update(cuerpo).digest('hex');
    const a = Buffer.from(esperado), b = Buffer.from(firma);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

// ---------- ManyChat (clientes reales) ----------
// Los contactos que llegan por ManyChat se guardan con el prefijo "mc_" + su id de ManyChat.
export const esManychat = (id: string) => id.startsWith('mc_');

async function credencial(clave: string) {
  const { data } = await db().from('credenciales').select('valor').eq('clave', clave).maybeSingle();
  return data?.valor || '';
}

export async function manychatActivo() {
  return !!(await credencial('manychat_token')) || !!(await credencial('sendpulse_client_id'));
}

// ---------- SendPulse (clientes reales) ----------
// Los contactos de SendPulse se guardan con el prefijo "sp_" + su id de contacto.
export const esSendpulse = (id: string) => id.startsWith('sp_');

async function tokenSendpulse() {
  const vence = Number(await credencial('sendpulse_token_vence'));
  if (vence > Date.now() + 60000) return credencial('sendpulse_token');
  const r = await fetch('https://api.sendpulse.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: await credencial('sendpulse_client_id'), client_secret: await credencial('sendpulse_client_secret') }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`SendPulse rechazó las credenciales: ${d.error_description || d.message || r.status}`);
  const ahora = new Date().toISOString();
  await db().from('credenciales').upsert([
    { clave: 'sendpulse_token', valor: d.access_token, actualizado: ahora },
    { clave: 'sendpulse_token_vence', valor: String(Date.now() + (d.expires_in || 3600) * 1000), actualizado: ahora },
  ]);
  return d.access_token as string;
}

async function enviarSendpulse(destinatario: string, mensajes: any[]) {
  const t = await tokenSendpulse();
  const r = await fetch('https://api.sendpulse.com/instagram/contacts/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify({ contact_id: destinatario.slice(3), messages: mensajes }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.success === false) throw new Error(`SendPulse rechazó el mensaje: ${d.message || JSON.stringify(d.errors || d).slice(0, 200)}`);
}

async function enviarManychat(destinatario: string, mensajes: any[]) {
  const t = await credencial('manychat_token');
  if (!t) throw new Error('Falta el token de ManyChat.');
  const r = await fetch('https://api.manychat.com/fb/sending/sendContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify({
      subscriber_id: Number(destinatario.slice(3)),
      data: { version: 'v2', content: { type: 'instagram', messages: mensajes, actions: [], quick_replies: [] } },
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.status === 'error') throw new Error(`ManyChat rechazó el mensaje: ${d.message || d.details?.messages?.[0]?.message || r.status}`);
}

export async function enviarDM(destinatario: string, texto: string): Promise<string[]> {
  if (esSendpulse(destinatario)) {
    const partes = texto.match(/[\s\S]{1,950}/g) ?? [texto];
    for (const p of partes) await enviarSendpulse(destinatario, [{ type: 'text', message: { text: p } }]);
    return [];
  }
  if (esManychat(destinatario)) {
    const partes = texto.match(/[\s\S]{1,950}/g) ?? [texto];
    await enviarManychat(destinatario, partes.map((p) => ({ type: 'text', text: p })));
    return [];
  }
  const t = await token();
  const ids: string[] = [];
  const partes = texto.match(/[\s\S]{1,950}/g) ?? [texto]; // Instagram corta en 1000 caracteres
  for (const parte of partes) {
    const r = await fetch(rutas(t).mensajes, {
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
  if (esManychat(igUsuario) || esSendpulse(igUsuario)) return credencial(`nombre_${igUsuario}`) || credencial(`mc_nombre_${igUsuario}`);
  try {
    const t = await token();
    const r = await fetch(`${rutas(t).base}/${igUsuario}?fields=name,username`, { headers: { Authorization: `Bearer ${t}` } });
    const d = await r.json();
    return d.name || (d.username ? `@${d.username}` : '');
  } catch { return ''; }
}

// El token largo de Instagram dura 60 días: lo renovamos cada semana.
export async function renovarToken() {
  const t = await token();
  if (!t.startsWith('IG')) return; // los tokens de usuario del sistema no vencen
  const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(t)}`);
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error(d?.error?.message || 'No se pudo renovar el token de Instagram.');
  await db().from('credenciales').upsert({ clave: 'instagram_token', valor: d.access_token, actualizado: new Date().toISOString() });
}
