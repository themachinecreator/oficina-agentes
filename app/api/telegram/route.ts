import { after } from 'next/server';
import { db } from '@/lib/db';
import { avisar, enviar, escribiendo, telegram } from '@/lib/telegram';
import { resolverAprobacion } from '@/lib/aprobaciones';
import { responderArthur } from '@/lib/arthur';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const ok = () => new Response('ok');

export async function POST(req: Request) {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('No autorizado', { status: 401 });
  }
  const update = await req.json();

  // Botones de aprobación (Enviar respuesta / No responder)
  if (update.callback_query) {
    const cq = update.callback_query;
    const dueño = process.env.TELEGRAM_OWNER_ID;
    const m = /^apr:(\d+):(si|no)$/.exec(cq.data || '');
    if (!dueño || String(cq.from.id) !== dueño) {
      await telegram('answerCallbackQuery', { callback_query_id: cq.id, text: 'Esta oficina es privada.' }).catch(() => {});
      return ok();
    }
    // Respondemos el botón al instante; publicar un reel puede tardar un par de minutos.
    await telegram('answerCallbackQuery', { callback_query_id: cq.id, text: 'Recibido, ya lo hago.' }).catch(() => {});
    if (m) after(async () => {
      const r = await resolverAprobacion(Number(m[1]), m[2] === 'si').catch((e: any) => `No pude completarlo: ${e.message}`);
      if (/^No (pude|encontré)|^Esto ya estaba/.test(r)) await avisar(r);
    });
    return ok();
  }

  const msg = update.message;
  if (!msg?.text) return ok();

  const chatId: number = msg.chat.id;
  const dueño = process.env.TELEGRAM_OWNER_ID;

  if (!dueño) {
    await enviar(chatId, `Tu ID de Telegram es ${msg.from.id}. Cargalo en Vercel como TELEGRAM_OWNER_ID y volvé a publicar el proyecto.`);
    return ok();
  }
  if (String(msg.from.id) !== dueño) {
    await enviar(chatId, 'Esta oficina es privada.');
    return ok();
  }
  if (msg.text === '/start') {
    await enviar(chatId, 'Buenas, Beltrán. Soy Arthur Whitmore, jefe de tu oficina. Decime qué necesitás y lo pongo en manos de quien corresponda.');
    return ok();
  }

  // Telegram reintenta si tardamos: el update_id único evita responder dos veces.
  const { error } = await db().from('mensajes')
    .insert({ chat_id: chatId, rol: 'user', contenido: msg.text, update_id: update.update_id });
  if (error) return ok();

  await escribiendo(chatId);
  // Respondemos a Telegram enseguida y trabajamos después (un guion puede tardar).
  after(async () => {
    const latido = setInterval(() => escribiendo(chatId), 5000);
    let respuesta: string;
    try {
      respuesta = await responderArthur(chatId, msg.text);
    } catch (e: any) {
      console.error(e);
      respuesta = 'Tuve un problema para responderte. Revisá que la clave de Claude y el crédito de la API estén bien.';
    } finally {
      clearInterval(latido);
    }
    await db().from('mensajes').insert({ chat_id: chatId, rol: 'assistant', contenido: respuesta });
    await enviar(chatId, respuesta);
  });
  return ok();
}
