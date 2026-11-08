import { cronAutorizado } from '@/lib/cron';
import { googleConectado } from '@/lib/google';
import { revisarCorreo } from '@/lib/eleanor';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function correr(req: Request) {
  if (!cronAutorizado(req)) return Response.json({ error: 'No autorizado' }, { status: 401 });
  if (!(await googleConectado())) return Response.json({ ok: true, mensaje: 'Google todavía no está conectado.' });
  try {
    return Response.json({ ok: true, ...(await revisarCorreo()) });
  } catch (e: any) {
    console.error(e);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
export const GET = correr;
export const POST = correr;
