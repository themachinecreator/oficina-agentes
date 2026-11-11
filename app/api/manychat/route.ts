import { after } from 'next/server';
import { db } from '@/lib/db';
import { responderMargaret } from '@/lib/margaret';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// ManyChat llama acá con una "solicitud externa" por cada mensaje de Instagram.
// Respondemos enseguida (ManyChat espera poco) y Margaret contesta después por la API de ManyChat.
const vacio = () => Response.json({ version: 'v2', content: { type: 'instagram', messages: [], actions: [], quick_replies: [] } });

export async function POST(req: Request) {
  const base = db();
  const { data: sec } = await base.from('credenciales').select('valor').eq('clave', 'manychat_secret').maybeSingle();
  if (!sec?.valor || req.headers.get('x-oficina-secret') !== sec.valor) return new Response('No autorizado', { status: 401 });

  const d = await req.json().catch(() => ({}));
  await base.from('webhook_log').insert({ origen: 'manychat', firma_ok: true, cuerpo: JSON.stringify(d).slice(0, 4000) }).then(() => {}, () => {});
  const id = String(d.subscriber_id || '').trim();
  const texto = String(d.text || '').trim();
  if (!/^\d+$/.test(id) || !texto || texto.includes('{{')) return vacio();

  const cliente = `mc_${id}`;
  const nombre = String(d.name || d.ig_username || '').trim();
  if (nombre && !nombre.includes('{{')) {
    await base.from('credenciales').upsert({ clave: `mc_nombre_${cliente}`, valor: d.ig_username && !String(d.ig_username).includes('{{') ? `${nombre} (@${d.ig_username})` : nombre, actualizado: new Date().toISOString() });
  }
  const { data: fila } = await base.from('ig_mensajes').insert({ ig_usuario: cliente, rol: 'user', texto }).select('id').single();
  if (fila) after(() => responderMargaret(cliente, fila.id).catch((e) => console.error('Margaret (ManyChat)', e)));
  return vacio();
}
