import { after } from 'next/server';
import { cronAutorizado } from '@/lib/cron';
import { editarReel, marcaDeAgua } from '@/lib/reel';
import { sugerirParaVideo } from '@/lib/julian';
import { editarHistoria } from '@/lib/historia';
import { avisar } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Arthur llama acá; respondemos enseguida y Theo edita en segundo plano (puede llevar un par de minutos).
export async function POST(req: Request) {
  if (!cronAutorizado(req)) return Response.json({ error: 'No autorizado' }, { status: 401 });
  const { guionId, musica, subtitulos, tipo, nombre, descripcion, recuadro } = await req.json().catch(() => ({}));
  if (tipo === 'historia') {
    after(() => editarHistoria(Number(guionId), { musica: musica === 'libre' ? 'libre' : 'sin' }).then(() => {}).catch(() => {}));
    return Response.json({ ok: true });
  }
  if (tipo === 'ideas') {
    after(async () => {
      const t = await sugerirParaVideo(String(descripcion || '')).catch((e: any) => `No pude opinar: ${e.message}`);
      await avisar(`Julian — sobre el video que editó Theo:\n${t}`);
    });
    return Response.json({ ok: true });
  }
  if (tipo === 'marca') {
    after(() => marcaDeAgua({ nombre, descripcion, recuadro: !!recuadro }).then(() => {}).catch(() => {}));
    return Response.json({ ok: true });
  }
  if (!Number.isFinite(Number(guionId))) return Response.json({ error: 'Falta el número de guion.' }, { status: 400 });
  after(() => editarReel(Number(guionId), { musica: musica === 'sin' ? 'sin' : 'libre', subtitulos: subtitulos !== false }).catch(() => {}));
  return Response.json({ ok: true });
}
