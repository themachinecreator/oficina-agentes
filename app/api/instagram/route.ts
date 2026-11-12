import { after } from 'next/server';
import { db } from '@/lib/db';
import { firmaValida, manychatActivo, guardarImagenes, imagenesDe } from '@/lib/instagram';
import { responderMargaret } from '@/lib/margaret';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Meta verifica el webhook con un GET al configurarlo.
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  if (p.get('hub.mode') === 'subscribe' && p.get('hub.verify_token') === process.env.INSTAGRAM_VERIFY_TOKEN) {
    return new Response(p.get('hub.challenge') || '', { status: 200 });
  }
  return new Response('No autorizado', { status: 403 });
}

// Margaret parte los mensajes largos: cada parte vuelve como un eco separado.
async function esParteDeRespuesta(base: ReturnType<typeof db>, cliente: string, texto: string) {
  const { data } = await base.from('ig_mensajes').select('texto').eq('ig_usuario', cliente).eq('rol', 'assistant')
    .gte('creado', new Date(Date.now() - 3 * 60000).toISOString()).order('id', { ascending: false }).limit(3);
  return (data || []).some((r) => r.texto.includes(texto.trim()));
}

export async function POST(req: Request) {
  const cuerpo = await req.text();
  const base = db();
  const firmaOk = firmaValida(cuerpo, req.headers.get('x-hub-signature-256'));
  // Registro para diagnóstico: se guardan solo los últimos 3 días.
  await base.from('webhook_log').insert({ origen: 'instagram', firma_ok: firmaOk, cuerpo: cuerpo.slice(0, 4000) }).then(() => {}, () => {});
  await base.from('webhook_log').delete().lt('creado', new Date(Date.now() - 3 * 86400000).toISOString()).then(() => {}, () => {});
  if (!firmaOk) return new Response('Firma inválida', { status: 401 });
  const datos = JSON.parse(cuerpo);
  // Con ManyChat activo, los mensajes de clientes los atiende esa conexión: evitamos responder dos veces.
  if (await manychatActivo()) return new Response('ok');

  for (const entrada of datos.entry || []) {
    // Meta manda los mensajes en entry[].messaging[] o, según la configuración, en entry[].changes[] con field "messages".
    const eventos = [
      ...(entrada.messaging || []),
      ...((entrada.changes || []).filter((c: any) => c.field === 'messages').map((c: any) => c.value)),
    ];
    for (const ev of eventos) {
      if (!ev?.sender?.id || !ev?.recipient?.id) continue;
      const m = ev.message;
      if (!m || m.is_deleted) continue;
      const adjuntos = imagenesDe(m.attachments);
      const texto = m.text || (adjuntos.length ? (adjuntos.length === 1 ? '[mandó una foto]' : `[mandó ${adjuntos.length} fotos]`) : (m.attachments?.length ? `[El cliente mandó ${m.attachments.length === 1 ? 'un adjunto' : 'adjuntos'}: ${m.attachments.map((a: any) => a.type).join(', ')}]` : ''));
      if (!texto) continue;

      if (m.is_echo) {
        // Un mensaje que salió de la cuenta. Si no lo mandó Margaret, lo escribió Beltrán a mano: pausamos a Margaret 12 h en ese chat.
        const cliente = String(ev.recipient.id);
        // Es de Margaret si coincide el id o si ella mandó ese mismo texto a ese cliente en los últimos 3 minutos.
        const { data: porId } = await base.from('ig_mensajes').select('id').eq('mid', m.mid).maybeSingle();
        const { data: porTexto } = await base.from('ig_mensajes').select('id')
          .eq('ig_usuario', cliente).eq('rol', 'assistant').eq('texto', texto)
          .gte('creado', new Date(Date.now() - 3 * 60000).toISOString()).limit(1).maybeSingle();
        const esMargaret = !!(porId || porTexto || (m.text && (await esParteDeRespuesta(base, cliente, m.text))));
        if (!esMargaret) {
          await base.from('ig_mensajes').insert({ ig_usuario: cliente, rol: 'assistant', texto, mid: m.mid }).then(() => {}, () => {});
          await base.from('credenciales').upsert({ clave: `ig_pausa_${cliente}`, valor: String(Date.now() + 12 * 3600000), actualizado: new Date().toISOString() });
        }
        continue;
      }

      const cliente = String(ev.sender.id);
      const { data: fila, error } = await base.from('ig_mensajes')
        .insert({ ig_usuario: cliente, rol: 'user', texto, mid: m.mid, imagenes: adjuntos.length ? await guardarImagenes(cliente, adjuntos) : null }).select('id').single();
      if (error || !fila) continue; // repetido
      after(() => responderMargaret(cliente, fila.id).catch((e) => console.error('Margaret', e)));
    }
  }
  return new Response('ok');
}
