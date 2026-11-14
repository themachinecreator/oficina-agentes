import { after } from 'next/server';
import { cronAutorizado } from '@/lib/cron';
import { pedirGuion } from '@/lib/julian';
import { dueñoChatId } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Pedido directo de un guion a Julian; él se lo manda a Beltrán por Telegram.
export async function POST(req: Request) {
  if (!cronAutorizado(req)) return Response.json({ error: 'No autorizado' }, { status: 401 });
  const { tema, formato, notas } = await req.json().catch(() => ({}));
  if (!tema) return Response.json({ error: 'Falta el tema.' }, { status: 400 });
  after(() => pedirGuion({ tema, formato, notas }, dueñoChatId() || undefined).then(() => {}).catch(() => {}));
  return Response.json({ ok: true });
}
