import path from 'path';
import { promises as fs } from 'fs';
import { db } from './db';
import { ffmpeg, carpetaTemporal } from './video';
import { transcribir } from './historia';

// Contexto que Instagram manda junto al mensaje y que Margaret necesita para no preguntar "¿qué reloj?":
// - respuesta a una historia (reply_to.story: id y archivo de la historia),
// - mensaje que viene de un anuncio (referral.ads_context_data),
// - publicación o reel compartido (attachments con ig_post_media_id / reel_video_id),
// - audios (se transcriben).
export type Contexto = { prefijo: string; imagenes: string[]; textoAudio: string };

async function relojDePublicacion(mediaId?: string | null) {
  if (!mediaId) return '';
  const { data } = await db().from('publicaciones').select('reloj, tipo').eq('ig_media_id', String(mediaId)).limit(1).maybeSingle();
  return (data?.reloj as string) || '';
}

// Guarda en nuestro storage una imagen de la historia/publicación (si es video, un cuadro del medio).
async function guardarCuadro(cliente: string, url: string): Promise<string> {
  const dir = await carpetaTemporal();
  try {
    const r = await fetch(url);
    if (!r.ok) return '';
    const tipo = r.headers.get('content-type') || '';
    const crudo = path.join(dir, 'crudo');
    await fs.writeFile(crudo, Buffer.from(await r.arrayBuffer()));
    const jpg = path.join(dir, 'cuadro.jpg');
    if (tipo.startsWith('video/')) await ffmpeg(['-ss', '1', '-i', crudo, '-frames:v', '1', '-vf', "scale='min(1080,iw)':-2", '-q:v', '3', jpg], 60000);
    else if (tipo.startsWith('image/')) await ffmpeg(['-i', crudo, '-frames:v', '1', '-vf', "scale='min(1600,iw)':-2", '-q:v', '3', jpg], 60000);
    else return '';
    const nombre = `ig/${cliente.replace(/[^\w-]/g, '')}/${Date.now()}-historia.jpg`;
    const { error } = await db().storage.from('publicaciones').upload(nombre, await fs.readFile(jpg), { contentType: 'image/jpeg', upsert: true });
    return error ? '' : `${process.env.SUPABASE_URL}/storage/v1/object/public/publicaciones/${nombre}`;
  } catch {
    return '';
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function transcribirAudio(url: string): Promise<string> {
  const dir = await carpetaTemporal();
  try {
    const r = await fetch(url);
    if (!r.ok) return '';
    const crudo = path.join(dir, 'audio'), mp3 = path.join(dir, 'audio.mp3');
    await fs.writeFile(crudo, Buffer.from(await r.arrayBuffer()));
    await ffmpeg(['-i', crudo, '-ac', '1', '-ar', '16000', '-b:a', '48k', mp3], 60000);
    const palabras = await transcribir(mp3);
    return palabras.map((w) => w.word).join(' ').replace(/\s+([,.!?])/g, '$1').trim();
  } catch {
    return '';
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function contextoDelMensaje(cliente: string, m: any): Promise<Contexto> {
  const partes: string[] = [];
  const imagenes: string[] = [];
  let textoAudio = '';
  if (!m || typeof m !== 'object') return { prefijo: '', imagenes, textoAudio };

  // Respuesta a una historia.
  const historia = m.reply_to?.story;
  if (historia?.id || historia?.url) {
    const reloj = await relojDePublicacion(historia.id);
    if (reloj) partes.push(`[Respondió a tu historia del ${reloj}]`);
    else {
      const img = historia.url ? await guardarCuadro(cliente, historia.url) : '';
      if (img) imagenes.push(img);
      partes.push(img ? '[Respondió a una de tus historias: la imagen de la historia va adjunta]' : '[Respondió a una de tus historias]');
    }
  }

  // Viene de un anuncio.
  const ad = m.referral?.ads_context_data;
  if (ad?.ad_title) partes.push(`[Te escribe desde tu anuncio: "${String(ad.ad_title).replace(/^Publicaci[oó]n de Instagram:\s*/i, '')}"]`);

  // Publicaciones/reels compartidos y audios.
  for (const a of (Array.isArray(m.attachments) ? m.attachments : [])) {
    const p = a?.payload || {};
    const mediaId = p.ig_post_media_id || p.reel_video_id;
    if (mediaId || ['share', 'ig_reel', 'reel'].includes(a?.type)) {
      const reloj = await relojDePublicacion(mediaId);
      partes.push(reloj ? `[Compartió tu publicación del ${reloj}]` : '[Compartió una publicación: la imagen va adjunta]');
    }
    if (a?.type === 'audio' && typeof p.url === 'string') {
      const t = await transcribirAudio(p.url);
      textoAudio = t ? `[Audio] ${t}` : '[Mandó un audio que no pude escuchar]';
    }
  }
  return { prefijo: partes.join(' '), imagenes, textoAudio };
}
