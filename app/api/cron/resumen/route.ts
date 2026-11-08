import { cronAutorizado } from '@/lib/cron';
import { resumenDiario } from '@/lib/eleanor';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function correr(req: Request) {
  if (!cronAutorizado(req)) return Response.json({ error: 'No autorizado' }, { status: 401 });
  await resumenDiario();
  return Response.json({ ok: true });
}
export const GET = correr;
export const POST = correr;
