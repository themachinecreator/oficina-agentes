import { cronAutorizado } from '@/lib/cron';
import { googleConectado } from '@/lib/google';
import { resumenFinanzas } from '@/lib/henry';
import { avisar } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// El día 1 de cada mes: resumen del mes que terminó.
async function correr(req: Request) {
  if (!cronAutorizado(req)) return Response.json({ error: 'No autorizado' }, { status: 401 });
  if (!(await googleConectado())) return Response.json({ ok: true, mensaje: 'Google no está conectado.' });
  const ayer = new Date(Date.now() - 86400000 - 3 * 3600000).toISOString().slice(0, 7);
  try {
    await avisar(`Henry: cierre del mes\n\n${await resumenFinanzas(ayer)}`);
    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
export const GET = correr;
export const POST = correr;
