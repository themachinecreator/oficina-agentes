import { after } from 'next/server';
import { db } from '@/lib/db';
import { responderMargaret } from '@/lib/margaret';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// SendPulse no firma sus webhooks: la URL lleva una clave secreta (?k=...).
function textoDe(ev: any): string {
  const m = ev?.info?.message?.channel_data?.message ?? ev?.info?.message ?? {};
  const t = typeof m.text === 'string' ? m.text : m.text?.body;
  return String(t || ev?.contact?.last_message || '').trim();
}

export async function POST(req: Request) {
  const base = db();
  const { data: sec } = await base.from('credenciales').select('valor').eq('clave', 'sendpulse_webhook_secret').maybeSingle();
  if (!sec?.valor || new URL(req.url).searchParams.get('k') !== sec.valor) return new Response('No autorizado', { status: 401 });

  const cuerpo = await req.text();
  await base.from('webhook_log').insert({ origen: 'sendpulse', firma_ok: true, cuerpo: cuerpo.slice(0, 4000) }).then(() => {}, () => {});
  let eventos: any[] = [];
  try { const d = JSON.parse(cuerpo); eventos = Array.isArray(d) ? d : [d]; } catch { return new Response('ok'); }

  for (const ev of eventos) {
    if (ev?.service && ev.service !== 'instagram') continue;
    const id = String(ev?.contact?.id || '').trim();
    const texto = textoDe(ev);
    if (!id || !texto) continue;
    const cliente = `sp_${id}`;

    if (ev.title === 'outgoing_message') {
      // Si el mensaje saliente no lo mandó Margaret, lo escribió Beltrán desde SendPulse: pausamos a Margaret 12 h.
      const { data: propio } = await base.from('ig_mensajes').select('id').eq('ig_usuario', cliente).eq('rol', 'assistant')
        .gte('creado', new Date(Date.now() - 3 * 60000).toISOString()).limit(5);
      const { data: textos } = await base.from('ig_mensajes').select('texto').eq('ig_usuario', cliente).eq('rol', 'assistant')
        .gte('creado', new Date(Date.now() - 3 * 60000).toISOString());
      const esMargaret = (propio?.length || 0) > 0 && (textos || []).some((r) => r.texto.includes(texto.slice(0, 200)));
      if (!esMargaret) {
        await base.from('ig_mensajes').insert({ ig_usuario: cliente, rol: 'assistant', texto });
        await base.from('credenciales').upsert({ clave: `ig_pausa_${cliente}`, valor: String(Date.now() + 12 * 3600000), actualizado: new Date().toISOString() });
      }
      continue;
    }
    if (ev.title !== 'incoming_message') continue;

    const nombre = String(ev.contact?.name || '').trim();
    const usuario = String(ev.contact?.username || '').trim();
    if (nombre || usuario) {
      await base.from('credenciales').upsert({ clave: `nombre_${cliente}`, valor: usuario ? `${nombre || usuario} (@${usuario})` : nombre, actualizado: new Date().toISOString() });
    }
    const mid = ev.info?.message?.id ? `sp_${ev.info.message.id}` : null;
    const { data: fila, error } = await base.from('ig_mensajes').insert({ ig_usuario: cliente, rol: 'user', texto, mid }).select('id').single();
    if (error || !fila) continue; // repetido
    after(() => responderMargaret(cliente, fila.id).catch((e) => console.error('Margaret (SendPulse)', e)));
  }
  return new Response('ok');
}
