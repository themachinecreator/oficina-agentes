import { after } from 'next/server';
import { cronAutorizado } from '@/lib/cron';
import { editarReel, marcaDeAgua } from '@/lib/reel';
import { sugerirParaVideo } from '@/lib/julian';
import { editarHistoria } from '@/lib/historia';
import { editarVozEnOff, montarVozEnOff } from '@/lib/vozenoff';
import { avisar } from '@/lib/telegram';
import { db } from '@/lib/db';
import { carpetaEditados, nombreParaDrive } from '@/lib/video';
import { subirADrive } from '@/lib/google';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Arthur llama acá; respondemos enseguida y Theo edita en segundo plano (puede llevar un par de minutos).
export async function POST(req: Request) {
  if (!cronAutorizado(req)) return Response.json({ error: 'No autorizado' }, { status: 401 });
  const { guionId, musica, subtitulos, tipo, nombre, descripcion, recuadro, cantidad, cancion, trabajo } = await req.json().catch(() => ({}));
  if (tipo === 'vozenoff') {
    after(() => editarVozEnOff({ guionId: Number(guionId) || undefined, musica: musica === 'libre' || cancion ? 'libre' : 'sin', cancion: cancion || undefined }).then(() => {}).catch(() => {}));
    return Response.json({ ok: true });
  }
  if (tipo === 'vozenoff-montaje' && typeof trabajo === 'string' && /^trabajo\/vozenoff-\d+$/.test(trabajo)) {
    after(() => montarVozEnOff(trabajo).then(() => {}).catch(() => {}));
    return Response.json({ ok: true });
  }
  if (tipo === 'historia') {
    after(() => editarHistoria(Number(guionId), { musica: musica === 'libre' ? 'libre' : 'sin' }).then(() => {}).catch(() => {}));
    return Response.json({ ok: true });
  }
  // Copia a "Videos editados" los reels que Theo ya había terminado (los últimos `cantidad`).
  if (tipo === 'guardar') {
    const carpeta = await carpetaEditados();
    if (!carpeta) return Response.json({ error: 'No encontré la carpeta Videos editados.' }, { status: 404 });
    const { data } = await db().from('publicaciones').select('id, reloj, archivo, creado').eq('tipo', 'reel').order('id', { ascending: false }).limit(Number(cantidad) || 1);
    const hechos: string[] = [];
    for (const p of data || []) {
      try {
        const r = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/public/publicaciones/${p.archivo}`);
        if (!r.ok) throw new Error(`no lo encontré (${r.status})`);
        const fecha = new Date(p.creado).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }).replace(/\//g, '-');
        const nombreArchivo = `${nombreParaDrive(String(p.reloj || ''))} (${fecha}).mp4`;
        await subirADrive(carpeta, nombreArchivo, Buffer.from(await r.arrayBuffer()));
        hechos.push(`ok: ${nombreArchivo}`);
      } catch (e: any) { hechos.push(`error #${p.id}: ${e.message}`); }
    }
    return Response.json({ ok: true, hechos });
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
