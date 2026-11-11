import { db } from './db';

const IG_ID = process.env.INSTAGRAM_ACCOUNT_ID || '17841447907774982';
const GRAPH = 'https://graph.facebook.com/v23.0';

async function token() {
  const { data } = await db().from('credenciales').select('valor').eq('clave', 'instagram_token').maybeSingle();
  if (!data?.valor) throw new Error('Falta el token de Instagram.');
  return data.valor;
}

async function graph(ruta: string, cuerpo?: Record<string, unknown>) {
  const t = await token();
  const r = await fetch(`${GRAPH}/${ruta}`, {
    method: cuerpo ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Instagram: ${d?.error?.error_user_msg || d?.error?.message || r.status}`);
  return d;
}

// Crea el contenedor; Instagram descarga y procesa el archivo desde la URL pública.
export async function crearContenedor(tipo: 'STORIES' | 'REELS', url: string, esVideo: boolean, texto?: string) {
  const cuerpo: Record<string, unknown> = { media_type: tipo };
  if (esVideo) cuerpo.video_url = url; else cuerpo.image_url = url;
  if (texto && tipo === 'REELS') { cuerpo.caption = texto; cuerpo.share_to_feed = true; }
  const d = await graph(`${IG_ID}/media`, cuerpo);
  return d.id as string;
}

export async function esperarContenedor(id: string, maxMs = 150000) {
  const inicio = Date.now();
  while (Date.now() - inicio < maxMs) {
    const d = await graph(`${id}?fields=status_code,status`);
    if (d.status_code === 'FINISHED') return;
    if (d.status_code === 'ERROR' || d.status_code === 'EXPIRED') throw new Error(`Instagram no pudo procesar el video: ${d.status || d.status_code}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('Instagram tardó demasiado en procesar el video.');
}

export async function publicarContenedor(id: string) {
  const d = await graph(`${IG_ID}/media_publish`, { creation_id: id });
  return d.id as string;
}
