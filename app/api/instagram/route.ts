import { after } from 'next/server';
import { db } from '@/lib/db';
import { firmaValida } from '@/lib/instagram';
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

export async function POST(req: Request) {
  const cuerpo = await req.text();
  if (!firmaValida(cuerpo, req.headers.get('x-hub-signature-256'))) return new Response('Firma inválida', { status: 401 });
  const datos = JSON.parse(cuerpo);
  const base = db();

  for (const entrada of datos.entry || []) {
    for (const ev of entrada.messaging || []) {
      const m = ev.message;
      if (!m || m.is_deleted) continue;
      const texto = m.text || (m.attachments?.length ? `[El cliente mandó ${m.attachments.length === 1 ? 'un adjunto' : 'adjuntos'}: ${m.attachments.map((a: any) => a.type).join(', ')}]` : '');
      if (!texto) continue;

      if (m.is_echo) {
        // Un mensaje que salió de la cuenta. Si no lo mandó Margaret, lo escribió Beltrán a mano: pausamos a Margaret 12 h en ese chat.
        const cliente = String(ev.recipient.id);
        const { data: propio } = await base.from('ig_mensajes').select('id').eq('mid', m.mid).maybeSingle();
        if (!propio) {
          await base.from('ig_mensajes').insert({ ig_usuario: cliente, rol: 'assistant', texto, mid: m.mid }).then(() => {}, () => {});
          await base.from('credenciales').upsert({ clave: `ig_pausa_${cliente}`, valor: String(Date.now() + 12 * 3600000), actualizado: new Date().toISOString() });
        }
        continue;
      }

      const cliente = String(ev.sender.id);
      const { data: fila, error } = await base.from('ig_mensajes')
        .insert({ ig_usuario: cliente, rol: 'user', texto, mid: m.mid }).select('id').single();
      if (error || !fila) continue; // repetido
      after(() => responderMargaret(cliente, fila.id).catch((e) => console.error('Margaret', e)));
    }
  }
  return new Response('ok');
}
