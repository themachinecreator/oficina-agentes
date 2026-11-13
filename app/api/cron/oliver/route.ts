import { after } from 'next/server';
import { cronAutorizado } from '@/lib/cron';
import { proponerPost } from '@/lib/oliver';
import { estadoLinkedin } from '@/lib/linkedin';
import { avisar } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Martes: Oliver propone la publicación de la semana. También avisa si la conexión está por vencer.
async function correr(req: Request) {
  if (!cronAutorizado(req)) return Response.json({ error: 'No autorizado' }, { status: 401 });
  const cuerpo = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  after(async () => {
    const { conectado, dias } = await estadoLinkedin();
    if (conectado && dias <= 7) await avisar(`Oliver — la conexión con LinkedIn vence en ${dias} días. Reconectá entrando a https://oficina-agentes-351k.vercel.app/api/linkedin/conectar`);
    await proponerPost({ tema: cuerpo.tema, notas: cuerpo.notas }).catch(() => {});
  });
  return Response.json({ ok: true });
}
export const GET = correr;
export const POST = correr;
