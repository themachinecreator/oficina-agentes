import { db } from '@/lib/db';
import { enviar, escribiendo } from '@/lib/telegram';
import { responderArthur } from '@/lib/arthur';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const ok = () => new Response('ok');

export async function POST(req: Request) {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('No autorizado', { status: 401 });
  }
  const update = await req.json();
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
  let respuesta: string;
  try {
    respuesta = await responderArthur(chatId, msg.text);
  } catch (e: any) {
    console.error(e);
    respuesta = 'Tuve un problema para responderte. Revisá que la clave de Claude y el crédito de la API estén bien.';
  }
  await db().from('mensajes').insert({ chat_id: chatId, rol: 'assistant', contenido: respuesta });
  await enviar(chatId, respuesta);
  return ok();
}
