import { cronAutorizado } from '@/lib/cron';
import { instagramConectado, renovarToken } from '@/lib/instagram';

export const dynamic = 'force-dynamic';

async function correr(req: Request) {
  if (!cronAutorizado(req)) return Response.json({ error: 'No autorizado' }, { status: 401 });
  if (!(await instagramConectado())) return Response.json({ ok: true, mensaje: 'Instagram todavía no está conectado.' });
  try { await renovarToken(); return Response.json({ ok: true }); }
  catch (e: any) { return Response.json({ ok: false, error: e.message }, { status: 500 }); }
}
export const GET = correr;
export const POST = correr;
