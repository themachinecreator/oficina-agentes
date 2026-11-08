import { telegram } from '@/lib/telegram';

export const dynamic = 'force-dynamic';

// Abrí /api/configurar-webhook una vez después de publicar: conecta el bot de Telegram con esta oficina.
export async function GET(req: Request) {
  const secreto = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secreto) return Response.json({ error: 'Falta TELEGRAM_WEBHOOK_SECRET en Vercel.' }, { status: 500 });
  const origen = new URL(req.url).origin;
  const r = await telegram('setWebhook', {
    url: `${origen}/api/telegram`,
    secret_token: secreto,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  return Response.json(r.ok
    ? { ok: true, mensaje: 'Listo: Arthur ya recibe tus mensajes. Escribile /start en Telegram.' }
    : { ok: false, mensaje: 'Telegram rechazó la configuración. Revisá TELEGRAM_BOT_TOKEN.', detalle: r.description });
}
