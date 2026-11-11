import { after } from 'next/server';
import { cronAutorizado } from '@/lib/cron';
import { editarReel, marcaDeAgua } from '@/lib/reel';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Arthur llama acá; respondemos enseguida y Theo edita en segundo plano (puede llevar un par de minutos).
export async function POST(req: Request) {
  if (!cronAutorizado(req)) return Response.json({ error: 'No autorizado' }, { status: 401 });
  const { guionId, musica, subtitulos, tipo, nombre, descripcion } = await req.json().catch(() => ({}));
  if (tipo === 'marca') {
    after(() => marcaDeAgua({ nombre, descripcion }).then(() => {}).catch(() => {}));
    return Response.json({ ok: true });
  }
  if (!Number.isFinite(Number(guionId))) return Response.json({ error: 'Falta el número de guion.' }, { status: 400 });
  after(() => editarReel(Number(guionId), { musica: musica === 'sin' ? 'sin' : 'libre', subtitulos: subtitulos !== false }).catch(() => {}));
  return Response.json({ ok: true });
}
