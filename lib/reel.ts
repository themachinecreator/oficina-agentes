import path from 'path';
import { promises as fs } from 'fs';
import { db, setAhora } from './db';
import { listarDrive } from './google';
import { carpetaRaiz } from './fotos';
import {
  ffmpeg, ffmpegInfo, filtroHdr, duracionYAudio, carpetaTemporal, bajarDeDrive, cancionAlAzar, logo,
  subirPublicacion, textoEnArchivo, FUENTE_FUERTE,
} from './video';
import { enviarConBotones, avisar } from './telegram';
import { crearAprobacion } from './aprobaciones';
import { sugerirParaVideo } from './julian';

// ---------- Leer el guion de Julian ----------
type Tramo = { nombre: string; texto: string };

export function leerGuion(contenido: string) {
  const lineas = contenido.split('\n').map((l) => l.trim());
  const tramos: Tramo[] = [];
  let actual: Tramo | null = null;
  const seccion = /^(texto de la publicaci[oó]n|hashtags|qu[eé] grabar|para theo|portada)\b/i;
  for (const l of lineas) {
    const t = /^\[\s*[\d.,]+\s*[–—-]\s*[\d.,]+\s*s?\s*\]\s*(.*)$/i.exec(l);
    if (t) { actual = { nombre: t[1], texto: '' }; tramos.push(actual); continue; }
    if (seccion.test(l)) { actual = null; continue; }
    if (actual && l && !/^en pantalla:/i.test(l)) {
      const citado = l.replace(/^[“"«]|[”"»]$/g, '').trim();
      actual.texto = `${actual.texto} ${citado}`.trim();
    }
  }
  const bloque = (nombre: RegExp) => {
    const i = lineas.findIndex((l) => nombre.test(l));
    if (i < 0) return '';
    const resto = lineas[i].replace(nombre, '').replace(/^[:\s]+/, '');
    const siguientes: string[] = [];
    for (const l of lineas.slice(i + 1)) { if (seccion.test(l)) break; if (l) siguientes.push(l); }
    return [resto, ...siguientes].filter(Boolean).join('\n').trim();
  };
  const texto = bloque(/^texto de la publicaci[oó]n/i);
  const hashtags = bloque(/^hashtags/i);
  return { tramos, caption: [texto, hashtags].filter(Boolean).join('\n\n') };
}

// Parte el texto de un tramo en subtítulos de pocas palabras, repartidos según su largo.
export function subtitulos(texto: string, inicio: number, dur: number) {
  const palabras = texto.split(/\s+/).filter(Boolean);
  if (!palabras.length || dur <= 0) return [];
  const bloques: string[] = [];
  for (let i = 0; i < palabras.length; i += 5) bloques.push(palabras.slice(i, i + 5).join(' '));
  const total = bloques.reduce((s, b) => s + b.length, 0);
  let t = inicio;
  return bloques.map((b) => { const d = dur * (b.length / total); const r = { texto: b, desde: t, hasta: t + d }; t += d; return r; });
}

// Recorta silencios al principio y al final de una toma.
export async function tramoConVoz(archivo: string, dur: number) {
  const info = await ffmpegInfo(['-i', archivo, '-af', 'silencedetect=noise=-32dB:d=0.35', '-f', 'null', '-']);
  const inicios = [...info.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const finales = [...info.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  let desde = 0, hasta = dur;
  if (inicios.length && inicios[0] < 0.05 && finales.length) desde = Math.max(0, finales[0] - 0.15);
  const ultimo = inicios[inicios.length - 1];
  if (ultimo !== undefined && ultimo > desde + 0.5 && (finales.length < inicios.length || finales[finales.length - 1] >= dur - 0.05)) hasta = Math.min(dur, ultimo + 0.25);
  return { desde, hasta: Math.max(hasta, desde + 0.5) };
}

async function carpetaTomas(guionId: number) {
  const base = await carpetaRaiz();
  const raiz = (await listarDrive(`${base ? `'${base}' in parents and ` : ''}mimeType = 'application/vnd.google-apps.folder' and trashed = false`))
    .filter((f: any) => /videos?\s+para\s+editar/i.test(f.name));
  if (!raiz.length) throw new Error('No encontré la carpeta "Videos para editar" en el Drive.');
  const subs = await listarDrive(`'${raiz[0].id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const c = subs.find((s) => new RegExp(`\\b${guionId}\\b`).test(s.name));
  if (!c) throw new Error(`No encontré la carpeta "Guion ${guionId}" dentro de "Videos para editar".`);
  const tomas = await listarDrive(`'${c.id}' in parents and trashed = false and mimeType contains 'video/'`, 'files(id,name,mimeType,createdTime,size)');
  const numero = (n: string) => { const m = /^\s*(\d+)/.exec(n); return m ? Number(m[1]) : Infinity; };
  tomas.sort((a, b) => numero(a.name) - numero(b.name) || String(a.createdTime).localeCompare(String(b.createdTime)));
  return tomas;
}

export type OpcionesReel = { musica: 'libre' | 'sin'; subtitulos?: boolean };

export async function editarReel(guionId: number, op: OpcionesReel) {
  const { data: g } = await db().from('guiones').select('id, titulo, contenido').eq('id', guionId).maybeSingle();
  if (!g) throw new Error(`No encontré el guion #${guionId}.`);
  const { tramos, caption } = leerGuion(g.contenido);
  const tomas = await carpetaTomas(guionId);
  if (!tomas.length) throw new Error(`La carpeta del guion ${guionId} no tiene videos.`);
  await setAhora('theo', `Editando el reel del guion #${guionId} (${tomas.length} tomas).`, 'ok');

  const dir = await carpetaTemporal();
  try {
    const partes: string[] = [];
    const subs: { texto: string; desde: number; hasta: number }[] = [];
    let t = 0;
    for (let k = 0; k < tomas.length; k++) {
      const original = await bajarDeDrive(tomas[k].id, path.join(dir, `toma${k}`));
      const { dur, audio } = await duracionYAudio(original);
      const { desde, hasta } = audio ? await tramoConVoz(original, dur) : { desde: 0, hasta: dur };
      const salida = path.join(dir, `parte${k}.mp4`);
      const largo = hasta - desde;
      const hdr = await filtroHdr(original);
      await ffmpeg([
        '-ss', desde.toFixed(2), '-t', largo.toFixed(2), '-i', original,
        '-f', 'lavfi', '-t', largo.toFixed(2), '-i', 'anullsrc=r=44100:cl=stereo',
        '-vf', `${hdr}scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,fps=30,setsar=1`,
        '-map', '0:v:0', '-map', audio ? '0:a:0' : '1:a:0',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-c:a', 'aac', '-ar', '44100', '-ac', '2', salida,
      ]);
      await fs.rm(original, { force: true });
      partes.push(salida);
      const texto = tramos[k]?.texto || '';
      if (op.subtitulos !== false && texto) subs.push(...subtitulos(texto, t + 0.1, largo - 0.2));
      t += largo;
    }
    const lista = path.join(dir, 'lista.txt');
    await fs.writeFile(lista, partes.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));

    const fuente = FUENTE_FUERTE.replace(/\\/g, '/').replace(/:/g, '\\:');
    const filtros: string[] = [];
    for (let i = 0; i < subs.length; i++) {
      const f = await textoEnArchivo(dir, `s${i}`, subs[i].texto);
      filtros.push(`drawtext=fontfile='${fuente}':textfile='${f}':fontsize=58:fontcolor=white:borderw=5:bordercolor=black@0.85:x=(w-tw)/2:y=h*0.70:enable='between(t,${subs[i].desde.toFixed(2)},${subs[i].hasta.toFixed(2)})'`);
    }
    const entradas = ['-f', 'concat', '-safe', '0', '-i', lista];
    let n = 1;
    let musicaIdx = -1, logoIdx = -1;
    let tema = '';
    if (op.musica === 'libre') { tema = await cancionAlAzar(path.join(dir, 'musica.mp3')); entradas.push('-stream_loop', '-1', '-i', path.join(dir, 'musica.mp3')); musicaIdx = n++; }
    const archivoLogo = await logo(path.join(dir, 'logo.png')).catch(() => null);
    if (archivoLogo) { entradas.push('-i', archivoLogo); logoIdx = n++; }

    let video = `[0:v]${filtros.length ? filtros.join(',') : 'null'}[vs]`;
    let ultimoV = '[vs]';
    if (logoIdx >= 0) { video += `;[${logoIdx}:v]scale=170:-1,format=rgba,colorchannelmixer=aa=0.85[lg];${ultimoV}[lg]overlay=W-w-50:60[vl]`; ultimoV = '[vl]'; }
    const audioF = musicaIdx >= 0
      ? `;[${musicaIdx}:a]volume=0.13,afade=t=in:d=0.8[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,afade=t=out:st=${Math.max(0, t - 1).toFixed(2)}:d=1[a]`
      : ';[0:a]anull[a]';
    const final = path.join(dir, 'reel.mp4');
    await ffmpeg([
      ...entradas, '-filter_complex', video + audioF, '-map', ultimoV, '-map', '[a]', '-t', t.toFixed(2),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-maxrate', '12M', '-bufsize', '24M', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', final,
    ]);
    const nombre = `reels/guion-${guionId}-${Date.now()}.mp4`;
    const url = await subirPublicacion(final, nombre);
    await db().from('publicaciones').insert({ tipo: 'reel', reloj: g.titulo, archivo: nombre, estado: 'para aprobar' });
    await db().from('guiones').update({ estado: 'editado', actualizado: new Date().toISOString() }).eq('id', guionId);

    const texto = `Theo — reel del guion #${guionId} listo (${Math.round(t)} s)\n${g.titulo}\n${op.musica === 'libre' ? `Música: ${tema.replace(/\.[^.]+$/, '')}` : 'Sin música: agregale un audio de tendencia en Instagram.'}\n\nVer video: ${url}\n\nTexto que se publica:\n${caption || '(sin texto)'}`;
    const id = await crearAprobacion('theo', texto, 'reel', { guionId, url, caption, musica: op.musica });
    const botones = op.musica === 'libre'
      ? [{ texto: 'Publicar', dato: `apr:${id}:si` }, { texto: 'No publicar', dato: `apr:${id}:no` }]
      : [{ texto: 'Lo publico yo', dato: `apr:${id}:no` }];
    const msgId = await enviarConBotones(texto, botones);
    if (msgId) await db().from('aprobaciones').update({ telegram_msg_id: msgId }).eq('id', id);
    await setAhora('theo', op.musica === 'libre' ? `Reel del guion #${guionId} listo: espera tu aprobación.` : `Reel del guion #${guionId} listo para que le pongas audio.`, op.musica === 'libre' ? 'wait' : 'ok');
    return { url, duracion: t };
  } catch (e: any) {
    await setAhora('theo', `No pudo editar el guion #${guionId}.`, 'idle');
    await avisar(`Theo no pudo editar el reel del guion #${guionId}: ${e.message}`);
    throw e;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- Video ya terminado (por ejemplo hecho con IA): formato Reel + marca de agua ----------
// Toma el video más reciente suelto en "Videos para editar" (o el que contenga `nombre`).
export async function marcaDeAgua(op: { nombre?: string; descripcion?: string }) {
  const base = await carpetaRaiz();
  const raiz = (await listarDrive(`${base ? `'${base}' in parents and ` : ''}mimeType = 'application/vnd.google-apps.folder' and trashed = false`))
    .filter((f: any) => /videos?\s+para\s+editar/i.test(f.name));
  if (!raiz.length) throw new Error('No encontré la carpeta "Videos para editar".');
  const videos = (await listarDrive(`'${raiz[0].id}' in parents and trashed = false and mimeType contains 'video/'`, 'files(id,name,mimeType,createdTime,size)'))
    .sort((a: any, b: any) => String(b.createdTime).localeCompare(String(a.createdTime)));
  const v = op.nombre ? videos.find((x: any) => x.name.toLowerCase().includes(op.nombre!.toLowerCase())) : videos[0];
  if (!v) throw new Error(op.nombre ? `No encontré un video con "${op.nombre}" en "Videos para editar".` : 'No hay videos sueltos en "Videos para editar".');
  await setAhora('theo', `Poniéndole la marca de agua a ${v.name}.`, 'ok');
  const dir = await carpetaTemporal();
  try {
    const original = await bajarDeDrive(v.id, path.join(dir, 'original'));
    const info = await ffmpegInfo(['-i', original]);
    const m = /Video:.*?(\d{3,5})x(\d{3,5})/.exec(info);
    const w = m ? Number(m[1]) : 1080, h = m ? Number(m[2]) : 1920;
    const { dur, audio } = await duracionYAudio(original);
    const vertical = Math.abs(w / h - 9 / 16) < 0.03;
    const altoVideo = vertical ? 1920 : Math.round((1080 * h) / w / 2) * 2;
    const abajo = vertical ? 1920 : Math.round((1920 + altoVideo) / 2);
    const hdr = await filtroHdr(original);
    // Si no es 9:16, el video va completo al centro sobre una versión desenfocada y oscurecida de sí mismo.
    const fondo = vertical
      ? `[0:v]${hdr}scale=1080:1920:flags=lanczos,setsar=1[base]`
      : `[0:v]${hdr}split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=40:6,eq=brightness=-0.12:saturation=0.8[bg];[b]scale=1080:-2:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[base]`;
    const archivoLogo = await logo(path.join(dir, 'logo.png'));
    if (!archivoLogo) throw new Error('No encontré el logo (PNG suelto en la carpeta Watches).');
    const yLogo = `${abajo}-h-34`;
    const filtro = `${fondo};[1:v]scale=150:-1,format=rgba,colorchannelmixer=aa=0.8[lg];[base][lg]overlay=W-w-34:${yLogo}[v]`;
    const final = path.join(dir, 'final.mp4');
    await ffmpeg([
      '-i', original, '-i', archivoLogo, '-filter_complex', filtro, '-map', '[v]', ...(audio ? ['-map', '0:a:0'] : []),
      '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-maxrate', '12M', '-bufsize', '24M', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      ...(audio ? ['-c:a', 'aac', '-b:a', '192k'] : []), '-movflags', '+faststart', final,
    ]);
    const nombre = `reels/marca-${Date.now()}.mp4`;
    const url = await subirPublicacion(final, nombre);
    await db().from('publicaciones').insert({ tipo: 'reel', reloj: v.name, archivo: nombre, estado: 'para aprobar' });
    await setAhora('julian', 'Mirando el video de Theo para sugerir mejoras.', 'ok');
    const desc = `${op.descripcion || 'Video publicitario de un reloj'}. Dura ${Math.round(dur)} s, formato vertical para Reels, ${audio ? 'con audio propio' : 'sin audio'}, logo chico abajo a la derecha.`;
    const ideas = await sugerirParaVideo(desc).catch(() => '');
    await setAhora('julian', 'Le pasó sus sugerencias a Theo.', 'ok');
    const texto = `Theo — video listo con tu marca de agua (${Math.round(dur)} s, formato Reel)\nVer video: ${url}${ideas ? `\n\nJulian sugiere:\n${ideas}` : ''}`;
    const id = await crearAprobacion('theo', texto, 'reel', { url, caption: '', musica: 'sin' });
    const msg = await enviarConBotones(texto, [{ texto: 'Lo publico yo', dato: `apr:${id}:no` }]);
    if (msg) await db().from('aprobaciones').update({ telegram_msg_id: msg }).eq('id', id);
    await setAhora('theo', 'Video con marca de agua listo para que lo publiques.', 'ok');
    return url;
  } catch (e: any) {
    await setAhora('theo', 'No pudo terminar la marca de agua.', 'idle');
    await avisar(`Theo no pudo ponerle la marca de agua: ${e.message}`);
    throw e;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
