import path from 'path';
import { promises as fs } from 'fs';
import { db, setAhora } from './db';
import { stockDisponible, carpetaDelReloj, Reloj } from './stock';
import { ffmpeg, filtroHdr, carpetaTemporal, bajarDeDrive, cancionAlAzar, subirPublicacion, textoEnArchivo, FUENTE_FUERTE, FUENTE_NORMAL } from './video';
import { crearContenedor, esperarContenedor, publicarContenedor } from './publicar';

const nombreReloj = (r: Reloj) => `${r['Marca'] || ''} ${r['Modelo'] || ''}`.replace(/\s+/g, ' ').trim();

// Historia vertical 1080x1920: video (o foto) del reloj sin su sonido, música de fondo y la ficha abajo.
export async function armarHistoria(r: Reloj) {
  const c = carpetaDelReloj(r);
  if (!c) throw new Error(`${nombreReloj(r)} no tiene fotos ni videos.`);
  const dir = await carpetaTemporal();
  try {
    const esVideo = c.videos.length > 0;
    const entrada = await bajarDeDrive(esVideo ? c.videos[0] : c.fotos[0], path.join(dir, esVideo ? 'entrada.mp4' : 'entrada.jpg'));
    const musica = path.join(dir, 'musica.mp3');
    const tema = await cancionAlAzar(musica);

    const linea2 = [r['Año'] && `Año ${r['Año']}`, r['Referencia'] && `Ref. ${r['Referencia']}`].filter(Boolean).join('  ·  ');
    const precio = r['Precio con descuento'] || r['Precio'] || r['Precio de lista'] || '';
    const t1 = await textoEnArchivo(dir, 't1', nombreReloj(r));
    const t2 = await textoEnArchivo(dir, 't2', linea2);
    const t3 = await textoEnArchivo(dir, 't3', precio);
    const t4 = await textoEnArchivo(dir, 't4', 'Consultas por privado');
    const f1 = FUENTE_FUERTE.replace(/\\/g, '/').replace(/:/g, '\\:');
    const f2 = FUENTE_NORMAL.replace(/\\/g, '/').replace(/:/g, '\\:');

    const hdr = esVideo ? await filtroHdr(entrada) : '';
    const base = esVideo
      ? `[0:v]${hdr}scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,unsharp=5:5:0.3:5:5:0,setsar=1,fps=30,trim=0:15,setpts=PTS-STARTPTS`
      : "[0:v]scale=1240:2204:force_original_aspect_ratio=increase,crop=1240:2204,zoompan=z='min(zoom+0.0007,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=240:s=1080x1920:fps=30,setsar=1";
    const ficha = [
      'drawbox=x=0:y=ih-600:w=iw:h=600:color=black@0.5:t=fill',
      `drawtext=fontfile='${f1}':textfile='${t1}':fontsize=64:fontcolor=white:x=(w-tw)/2:y=h-520`,
      linea2 ? `drawtext=fontfile='${f2}':textfile='${t2}':fontsize=44:fontcolor=white@0.9:x=(w-tw)/2:y=h-420` : '',
      precio ? `drawtext=fontfile='${f1}':textfile='${t3}':fontsize=84:fontcolor=0xE3C27A:x=(w-tw)/2:y=h-320` : '',
      `drawtext=fontfile='${f2}':textfile='${t4}':fontsize=38:fontcolor=white@0.85:x=(w-tw)/2:y=h-170`,
    ].filter(Boolean).join(',');
    const salida = path.join(dir, 'historia.mp4');
    const entradaArgs = esVideo ? ['-t', '15', '-i', entrada] : ['-loop', '1', '-t', '8', '-i', entrada];
    await ffmpeg([
      ...entradaArgs, '-stream_loop', '-1', '-i', musica,
      '-filter_complex', `${base},${ficha}[v];[1:a]volume=0.8,afade=t=in:d=0.6[a]`,
      '-map', '[v]', '-map', '[a]', '-t', esVideo ? '15' : '8', '-shortest',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-maxrate', '10M', '-bufsize', '20M', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', salida,
    ]);
    const nombre = `historias/${new Date().toISOString().slice(0, 10)}-${(r['Referencia'] || nombreReloj(r)).replace(/[^\w-]/g, '')}-${Date.now()}.mp4`;
    const url = await subirPublicacion(salida, nombre);
    return { url, archivo: nombre, tema };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function publicarHistoriaDe(r: Reloj, publicar = true) {
  const { url, archivo, tema } = await armarHistoria(r);
  const { data: fila } = await db().from('publicaciones').insert({ tipo: 'historia', reloj: nombreReloj(r), archivo, estado: 'armada' }).select('id').single();
  if (!publicar) return { url, tema };
  try {
    const cont = await crearContenedor('STORIES', url, true);
    await esperarContenedor(cont);
    const id = await publicarContenedor(cont);
    await db().from('publicaciones').update({ estado: 'publicada', ig_media_id: id }).eq('id', fila?.id);
    return { url, tema, id };
  } catch (e: any) {
    await db().from('publicaciones').update({ estado: 'error', error: e.message }).eq('id', fila?.id);
    throw e;
  }
}

export async function relojesParaHistorias() {
  return stockDisponible();
}

export { setAhora };

// Publica las historias de prueba que Beltrán vio y aprobó (sin volver a armarlas).
export async function publicarArmadas(minutos = 90) {
  const desde = new Date(Date.now() - minutos * 60000).toISOString();
  const { data } = await db().from('publicaciones').select('id, reloj, archivo').eq('tipo', 'historia').eq('estado', 'armada').gte('creado', desde).order('id');
  const hechas: string[] = [];
  for (const p of data || []) {
    try {
      const url = `${process.env.SUPABASE_URL}/storage/v1/object/public/publicaciones/${p.archivo}`;
      const cont = await crearContenedor('STORIES', url, true);
      await esperarContenedor(cont);
      const id = await publicarContenedor(cont);
      await db().from('publicaciones').update({ estado: 'publicada', ig_media_id: id }).eq('id', p.id);
      hechas.push(p.reloj);
    } catch (e: any) {
      await db().from('publicaciones').update({ estado: 'error', error: e.message }).eq('id', p.id);
    }
  }
  return hechas;
}
