import { db } from './db';

// LinkedIn: publicar en el perfil personal de Beltrán (productos "Share on LinkedIn" + "Sign In with OpenID Connect").
// El token dura 60 días y LinkedIn no da renovación automática a apps comunes: hay que reconectar.
const VERSION = process.env.LINKEDIN_VERSION || '202510';

async function cred(clave: string) {
  const { data } = await db().from('credenciales').select('valor').eq('clave', clave).maybeSingle();
  return (data?.valor as string) || '';
}
async function guardar(clave: string, valor: string) {
  await db().from('credenciales').upsert({ clave, valor, actualizado: new Date().toISOString() });
}

export async function urlConexion(redirect: string, state: string) {
  const id = await cred('linkedin_client_id') || process.env.LINKEDIN_CLIENT_ID || '';
  if (!id) throw new Error('Falta el Client ID de LinkedIn.');
  const p = new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: redirect, state, scope: 'openid profile w_member_social' });
  return `https://www.linkedin.com/oauth/v2/authorization?${p}`;
}

export async function canjearCodigoLinkedin(code: string, redirect: string) {
  const id = await cred('linkedin_client_id') || process.env.LINKEDIN_CLIENT_ID || '';
  const secreto = await cred('linkedin_client_secret') || process.env.LINKEDIN_CLIENT_SECRET || '';
  const r = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: id, client_secret: secreto }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(d.error_description || d.error || `LinkedIn ${r.status}`);
  const yo = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${d.access_token}` } }).then((x) => x.json());
  if (!yo?.sub) throw new Error('No pude leer tu perfil de LinkedIn.');
  await guardar('linkedin_token', d.access_token);
  await guardar('linkedin_vence', String(Date.now() + Number(d.expires_in || 5184000) * 1000));
  await guardar('linkedin_autor', `urn:li:person:${yo.sub}`);
  return yo.name as string;
}

export async function estadoLinkedin() {
  const [token, vence] = await Promise.all([cred('linkedin_token'), cred('linkedin_vence')]);
  if (!token) return { conectado: false, dias: 0 };
  const dias = Math.floor((Number(vence) - Date.now()) / 86400000);
  return { conectado: dias > 0, dias };
}

export async function publicarEnLinkedin(texto: string) {
  const [token, autor] = await Promise.all([cred('linkedin_token'), cred('linkedin_autor')]);
  const { conectado } = await estadoLinkedin();
  if (!token || !autor || !conectado) throw new Error('LinkedIn no está conectado (o venció la conexión): entrá a /api/linkedin/conectar.');
  // En el formato "little text" de LinkedIn hay caracteres reservados que se escapan con barra.
  // Los hashtags van con su plantilla para que queden clickeables.
  const escapar = (t: string) => t.replace(/([\\|{}@\[\]()<>#*_~])/g, '\\$1');
  const commentary = texto.split(/(#[\p{L}\p{N}_]+)/u).map((parte) => /^#[\p{L}\p{N}_]+$/u.test(parte) ? `{hashtag|\\#|${parte.slice(1)}}` : escapar(parte)).join('');
  const r = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'LinkedIn-Version': VERSION, 'X-Restli-Protocol-Version': '2.0.0' },
    body: JSON.stringify({
      author: autor, commentary, visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
    }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(`LinkedIn: ${d?.message || r.status}`);
  }
  return r.headers.get('x-restli-id') || r.headers.get('x-linkedin-id') || '';
}
