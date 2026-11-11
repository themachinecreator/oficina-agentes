import { after } from 'next/server';
import { cronAutorizado } from '@/lib/cron';
import { trabajarHenry } from '@/lib/henry-agente';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Arthur le pasa un pedido abierto a Henry; respondemos enseguida y Henry trabaja en segundo plano.
export async function POST(req: Request) {
  if (!cronAutorizado(req)) return Response.json({ error: 'No autorizado' }, { status: 401 });
  const { pedido, tareaId } = await req.json().catch(() => ({}));
  if (!pedido) return Response.json({ error: 'Falta el pedido.' }, { status: 400 });
  after(() => trabajarHenry(String(pedido), Number(tareaId) || undefined).catch(() => {}));
  return Response.json({ ok: true });
}
