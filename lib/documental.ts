import path from 'path';
import { promises as fs } from 'fs';
import { db, setAhora } from './db';
import { listarDrive, jpegDeDrive } from './google';
import { carpetaRaiz } from './fotos';
import {
  ffmpeg, ffmpegInfo, duracionYAudio, filtroHdr, carpetaTemporal, bajarDeDrive, cancionAlAzar, logo,
  subirPublicacion, guardarEnDrive, textoEnArchivo, FUENTE_FUERTE,
} from './video';
import { enviarConBotones, avisar } from './telegram';
import { crearAprobacion } from './aprobaciones';
import { transcribir, subtitulosPorPalabra, leerHistoria } from './historia';
import { leerGuion } from './reel';
import { stockDisponible, carpetaDelReloj } from './stock';

// ---------- Video de historia "documental" ----------
// Clips a cámara (carpeta "Videos": Acamara1, Acamara2...) y voz en off (carpeta "Voz": Toma 1, Toma 2...)
// que se alternan en el orden del guion. Mientras habla la voz en off se ven las escenas (carpeta "fotos"),
// sin su sonido, con un efecto de sonido al entrar cada una. Subtítulos, logo y música baja.
// Se procesa por pasos (un cron por minuto) para no pasarse del tiempo máximo de cada ejecución.

type Palabra = { word: string; start: number; end: number };
type Escena = { id: string; desc: string; archivo?: { id: string; nombre: string; video: boolean }; desde?: number };
type Segmento = { tipo: 'camara' | 'off'; archivoId: string; nombre: string; escenas: Escena[]; hecho?: string; dur?: number; palabras?: Palabra[]; entradas?: number[] };
type Trabajo = { guionId: number; titulo: string; caption: string; carpeta: string; segmentos: Segmento[]; respaldo?: string; trabajandoHasta?: number; inicio: string; avisos: string[]; intentosFinal?: number };

const numeroDe = (n: string) => { const m = /(\d+)/.exec(n); return m ? Number(m[1]) : 999; };
const pegado = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const palabrasClave = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .split(/[^a-z0-9]+/).filter((w) => (w.length >= 4 && !/^(para|como|desde|tengo|mano|toma|propia|plano|primer|cerrado|reloj|watch|photo|vintage|first|generation|soft|light|with|from|shot)$/.test(w)) || /^\d{3,}$/.test(w));

async function leerTrabajo(): Promise<Trabajo | null> {
  const { data } = await db().from('credenciales').select('valor').eq('clave', 'theo_documental').maybeSingle();
  try { return data?.valor ? JSON.parse(data.valor) : null; } catch { return null; }
}
async function guardarTrabajo(t: Trabajo | null) {
  await db().from('credenciales').upsert({ clave: 'theo_documental', valor: t ? JSON.stringify(t) : '', actualizado: new Date().toISOString() });
}

// Empareja cada escena del guion (B1, B2...) con un archivo de la carpeta "fotos" por palabras del nombre.
function emparejarEscenas(escenas: Escena[], archivos: { id: string; name: string; mimeType: string }[]) {
  const pares: { e: Escena; a: (typeof archivos)[number]; p: number }[] = [];
  for (const a of archivos) {
    const n = pegado(a.name.replace(/\.[^.]+(\.[^.]+)?$/, ''));
    for (const e of escenas) {
      const p = palabrasClave(e.desc).filter((k) => n.includes(k.length > 4 ? k.slice(0, k.length - 1) : k)).length;
      if (p > 0) pares.push({ e, a, p });
    }
  }
  pares.sort((x, y) => y.p - x.p);
  const usados = new Set<string>();
  for (const { e, a } of pares) {
    if (e.archivo || usados.has(a.id)) continue;
    e.archivo = { id: a.id, nombre: a.name, video: a.mimeType.startsWith('video/') };
    usados.add(a.id);
  }
}

export async function iniciarDocumental(guionId: number) {
  const { data: g } = await db().from('guiones').select('titulo, contenido').eq('id', guionId).maybeSingle();
  if (!g) throw new Error(`No encontré el guion ${guionId}.`);
  const tramos = leerHistoria(g.contenido);
  const raiz = await carpetaRaiz();
  const base = (await listarDrive(`${raiz ? `'${raiz}' in parents and ` : ''}mimeType = 'application/vnd.google-apps.folder' and trashed = false`))
    .find((f: any) => /para\s+editar/i.test(f.name));
  if (!base) throw new Error('No encontré la carpeta de videos para editar.');
  const subs = await listarDrive(`'${base.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const deGuion = subs.find((s: any) => new RegExp(`\\b${guionId}\\b`).test(s.name));
  const dentro = deGuion ? await listarDrive(`'${deGuion.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`) : subs;
  const voz = dentro.find((s: any) => /^voz|voces|audio/i.test(s.name));
  const videos = dentro.find((s: any) => /^video|tomas|c[aá]mara/i.test(s.name));
  const fotosDir = dentro.find((s: any) => /^fotos?|escenas|im[aá]genes/i.test(String(s.name).trim()));
  if (!voz || !videos) throw new Error('Necesito las carpetas "Voz" (voz en off) y "Videos" (clips a cámara).');
  const audios = (await listarDrive(`'${voz.id}' in parents and trashed = false and mimeType contains 'audio/'`, 'files(id,name,mimeType)'))
    .sort((a: any, b: any) => numeroDe(a.name) - numeroDe(b.name));
  // Clips a cámara: los que tienen número en el nombre, sin copias repetidas (mismo tamaño).
  const todos = await listarDrive(`'${videos.id}' in parents and trashed = false and mimeType contains 'video/'`, 'files(id,name,mimeType,size)');
  const vistos = new Set<string>();
  const clips = todos.filter((c: any) => /c[aá]mara|toma|clip/i.test(c.name) || todos.length <= 4)
    .sort((a: any, b: any) => numeroDe(a.name) - numeroDe(b.name))
    .filter((c: any) => { const k = String(c.size); if (vistos.has(k)) return false; vistos.add(k); return true; });
  const archivosEscenas = fotosDir ? await listarDrive(`'${fotosDir.id}' in parents and trashed = false and (mimeType contains 'image/' or mimeType contains 'video/')`, 'files(id,name,mimeType)') : [];

  const nCam = tramos.filter((t) => t.tipo === 'camara').length, nOff = tramos.filter((t) => t.tipo === 'off').length;
  const avisos: string[] = [];
  if (clips.length < nCam) avisos.push(`El guion tiene ${nCam} partes a cámara y encontré ${clips.length} clips.`);
  if (audios.length < nOff) avisos.push(`El guion tiene ${nOff} partes de voz en off y encontré ${audios.length} audios.`);

  const segmentos: Segmento[] = [];
  let ic = 0, io = 0;
  for (const t of tramos) {
    if (t.tipo === 'camara') { const c = clips[ic++]; if (c) segmentos.push({ tipo: 'camara', archivoId: c.id, nombre: c.name, escenas: [] }); }
    else { const a = audios[io++]; if (a) segmentos.push({ tipo: 'off', archivoId: a.id, nombre: a.name, escenas: t.apoyos.map((p) => ({ id: p.id, desc: `${p.desc} ${p.ref}` })) }); }
  }
  emparejarEscenas(segmentos.flatMap((s) => s.escenas), archivosEscenas);

  // Respaldo para las tomas del reloj que faltan: el video del reloj del guion (de tu stock o el del socio).
  let respaldo = '';
  const claveTitulo = pegado(g.titulo);
  for (const r of await stockDisponible().catch(() => [])) {
    const m = pegado(r['Modelo'] || '');
    if (m.length >= 4 && claveTitulo.includes(m)) { const c = carpetaDelReloj(r); if (c?.videos?.length) { respaldo = c.videos[0]; break; } }
  }
  const faltan = segmentos.flatMap((s) => s.escenas).filter((e) => !e.archivo);
  if (faltan.length) avisos.push(`Escenas sin archivo: ${faltan.map((e) => e.id).join(', ')}${respaldo ? ' (las tomas del reloj las cubro con el video del reloj que ya teníamos)' : ''}.`);

  const t: Trabajo = { guionId, titulo: g.titulo, caption: leerGuion(g.contenido).caption, carpeta: `trabajo/doc-${Date.now()}`, segmentos, respaldo, inicio: new Date().toISOString(), avisos };
  await guardarTrabajo(t);
  await setAhora('theo', `Arrancó el video de historia del guion ${guionId} (${segmentos.length} partes).`, 'ok');
  return { partes: segmentos.length, escenas: segmentos.flatMap((s) => s.escenas).map((e) => `${e.id}: ${e.archivo?.nombre || '—'}`), avisos };
}

const VIDEO_OUT = ['-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2'];

// Imagen o video de una escena a 1080x1920: si no es vertical, va entera al medio con el fondo desenfocado.
async function prepararEscena(dir: string, k: string, archivo: { id: string; video: boolean }, dur: number, desde = 0) {
  const salida = path.join(dir, `esc${k}.mp4`);
  if (!archivo.video) {
    const crudo = path.join(dir, `img${k}`), jpg = path.join(dir, `img${k}.jpg`);
    try { await bajarDeDrive(archivo.id, crudo); await ffmpeg(['-i', crudo, '-frames:v', '1', '-q:v', '2', jpg], 60000); }
    catch { await fs.writeFile(jpg, await jpegDeDrive(archivo.id, 1600)); }
    const marco = path.join(dir, `marco${k}.png`);
    await ffmpeg(['-i', jpg, '-filter_complex', '[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:2,eq=brightness=-0.15[f];[b]scale=1000:1700:force_original_aspect_ratio=decrease:flags=lanczos[c];[f][c]overlay=(W-w)/2:(H-h)/2,setsar=1', '-frames:v', '1', marco], 60000);
    const cuadros = Math.max(1, Math.round(dur * 30));
    await ffmpeg(['-loop', '1', '-framerate', '30', '-t', dur.toFixed(2), '-i', marco, '-vf', `scale=1188:2112,zoompan=z='min(zoom+0.0009,1.1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${cuadros}:s=1080x1920:fps=30,setsar=1,format=yuv420p`, '-an', '-t', dur.toFixed(2), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', salida], 120000);
    return salida;
  }
  const vid = await bajarDeDrive(archivo.id, path.join(dir, `vid${k}`));
  const info = await ffmpegInfo(['-i', vid]);
  const m = /, (\d{3,5})x(\d{3,5})/.exec(info);
  const vertical = m ? Number(m[2]) >= Number(m[1]) : true;
  const { dur: largo } = await duracionYAudio(vid);
  const inicio = largo > dur + 0.5 ? Math.min(desde, Math.max(0, largo - dur - 0.2)) : 0;
  const hdr = await filtroHdr(vid);
  const filtro = vertical
    ? `[0:v]${hdr}scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,fps=30,setsar=1,format=yuv420p[v]`
    : `[0:v]${hdr}split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:2,eq=brightness=-0.15[f];[b]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos[c];[f][c]overlay=(W-w)/2:(H-h)/2,fps=30,setsar=1,format=yuv420p[v]`;
  // Si el video es más corto que el tramo, se repite.
  await ffmpeg([...(largo < dur ? ['-stream_loop', '-1'] : []), '-ss', inicio.toFixed(2), '-i', vid, '-filter_complex', filtro, '-map', '[v]', '-an', '-t', dur.toFixed(2), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', salida], 200000);
  return salida;
}

// Un paso: procesa la próxima parte pendiente o, si están todas, arma el video final.
export async function pasoDocumental() {
  const t = await leerTrabajo();
  if (!t) return 'nada';
  if (t.trabajandoHasta && t.trabajandoHasta > Date.now()) return 'ocupado';
  t.trabajandoHasta = Date.now() + 5 * 60000;
  await guardarTrabajo(t);
  const k = t.segmentos.findIndex((s) => !s.hecho);
  try {
    if (k >= 0) await procesarSegmento(t, k);
    else { await montarFinal(t); await guardarTrabajo(null); return 'terminado'; }
  } catch (e: any) {
    // El final se reintenta una vez sin perder las partes ya armadas; una parte que falla se reintenta en el próximo minuto.
    if (k < 0) {
      t.intentosFinal = (t.intentosFinal || 0) + 1;
      if (t.intentosFinal >= 2) {
        await avisar(`Theo no pudo armar el final del video de historia: ${e.message}`);
        await setAhora('theo', `No pudo armar el video de historia: ${String(e.message).slice(0, 140)}`, 'idle');
        delete t.trabajandoHasta; t.intentosFinal = 0; await guardarTrabajo({ ...t, segmentos: t.segmentos, avisos: t.avisos });
        await db().from('credenciales').upsert({ clave: 'theo_documental_pausado', valor: JSON.stringify(t), actualizado: new Date().toISOString() });
        await guardarTrabajo(null);
        return 'error';
      }
    } else {
      await avisar(`Theo no pudo armar la parte ${k + 1} del video de historia: ${e.message}`);
      await setAhora('theo', `No pudo armar el video de historia: ${String(e.message).slice(0, 140)}`, 'idle');
      await db().from('credenciales').upsert({ clave: 'theo_documental_pausado', valor: JSON.stringify(t), actualizado: new Date().toISOString() });
      await guardarTrabajo(null);
      return 'error';
    }
  }
  delete t.trabajandoHasta;
  await guardarTrabajo(t);
  return `parte ${k + 1}`;
}

async function procesarSegmento(t: Trabajo, k: number) {
  const s = t.segmentos[k];
  await setAhora('theo', `Video de historia: parte ${k + 1} de ${t.segmentos.length} (${s.tipo === 'camara' ? 'a cámara' : 'voz en off'}).`, 'ok');
  const dir = await carpetaTemporal();
  try {
    const salida = path.join(dir, 'seg.mp4');
    if (s.tipo === 'camara') {
      // Clip a cámara: se corta desde la primera palabra hasta la última (saca el final donde cortás la grabación).
      const vid = await bajarDeDrive(s.archivoId, path.join(dir, 'cam'));
      const mp3 = path.join(dir, 'cam.mp3');
      await ffmpeg(['-i', vid, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', mp3]);
      const { dur: largo } = await duracionYAudio(vid);
      const ws = await transcribir(mp3).catch(() => [] as Palabra[]);
      const a = ws.length ? Math.max(0, ws[0].start - 0.15) : 0;
      const b = ws.length ? Math.min(largo, ws[ws.length - 1].end + 0.35) : largo;
      const hdr = await filtroHdr(vid);
      await ffmpeg(['-ss', a.toFixed(2), '-to', b.toFixed(2), '-i', vid, '-filter_complex',
        `[0:v]${hdr}scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,fps=30,setsar=1,format=yuv420p[v];[0:a]highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11[au]`,
        '-map', '[v]', '-map', '[au]', ...VIDEO_OUT, '-movflags', '+faststart', salida], 240000);
      s.dur = b - a;
      s.palabras = ws.map((w) => ({ word: w.word, start: Math.max(0, w.start - a), end: Math.max(0, w.end - a) }));
      s.entradas = [];
    } else {
      // Voz en off: audio sin silencios en los bordes; encima, las escenas repartidas en partes iguales y sin sonido.
      const orig = await bajarDeDrive(s.archivoId, path.join(dir, 'voz'));
      const limpio = path.join(dir, 'voz.wav');
      await ffmpeg(['-i', orig, '-af', 'silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.1,areverse,silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.15,areverse,apad=pad_dur=0.3,highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '44100', '-ac', '2', limpio]);
      const { dur } = await duracionYAudio(limpio);
      const mp3 = path.join(dir, 'voz.mp3');
      await ffmpeg(['-i', limpio, '-ac', '1', '-ar', '16000', '-b:a', '48k', mp3]);
      s.palabras = await transcribir(mp3).catch(() => []);
      s.dur = dur;
      // Escenas con archivo; las que faltan y son tomas del reloj se cubren con el video del reloj.
      const usar: { id: string; video: boolean; desde: number }[] = [];
      let usoRespaldo = 0;
      for (const e of s.escenas) {
        if (e.archivo) usar.push({ id: e.archivo.id, video: e.archivo.video, desde: 0 });
        else if (t.respaldo && /toma propia|reloj que tengo|dial|bisel|corona/i.test(e.desc)) usar.push({ id: t.respaldo, video: true, desde: 2 + (k * 3 + usoRespaldo++ * 4) % 12 });
      }
      if (!usar.length && t.respaldo) usar.push({ id: t.respaldo, video: true, desde: 1 });
      if (!usar.length) throw new Error(`la voz en off ${k + 1} no tiene ninguna escena para mostrar`);
      const tramo = dur / usar.length;
      const partes: string[] = [];
      for (const [i, u] of usar.entries()) partes.push(await prepararEscena(dir, `${i}`, u, tramo + 0.05, u.desde));
      const lista = path.join(dir, 'lista.txt');
      await fs.writeFile(lista, partes.map((p) => `file '${p}'`).join('\n'));
      const visual = path.join(dir, 'visual.mp4');
      await ffmpeg(['-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', visual]);
      await ffmpeg(['-i', visual, '-i', limpio, '-map', '0:v', '-map', '1:a', '-t', dur.toFixed(2), ...VIDEO_OUT, '-movflags', '+faststart', salida], 200000);
      s.entradas = usar.map((_, i) => i * tramo);
    }
    s.hecho = `${t.carpeta}/seg${k}.mp4`;
    await subirPublicacion(salida, s.hecho);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function montarFinal(t: Trabajo) {
  await setAhora('theo', 'Video de historia: armando el final (subtítulos, sonido y logo).', 'ok');
  const dir = await carpetaTemporal();
  try {
    const partes: string[] = [];
    for (const [k, s] of t.segmentos.entries()) {
      const r = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/public/publicaciones/${s.hecho}`);
      if (!r.ok) throw new Error(`no encontré la parte ${k + 1} (${r.status})`);
      const p = path.join(dir, `seg${k}.mp4`);
      await fs.writeFile(p, Buffer.from(await r.arrayBuffer()));
      partes.push(p);
    }
    const lista = path.join(dir, 'lista.txt');
    await fs.writeFile(lista, partes.map((p) => `file '${p}'`).join('\n'));
    const base = path.join(dir, 'base.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', base]);
    const { dur: total } = await duracionYAudio(base);
    for (const [k, p] of partes.entries()) if (!t.segmentos[k].dur) t.segmentos[k].dur = (await duracionYAudio(p)).dur;
    if (!t.caption) {
      const { data: g } = await db().from('guiones').select('contenido').eq('id', t.guionId).maybeSingle();
      if (g) t.caption = leerGuion(g.contenido).caption;
    }

    // Tiempos globales: palabras para subtítulos y entradas de escenas para el efecto de sonido.
    const palabras: Palabra[] = [];
    const golpes: number[] = [];
    let acc = 0;
    for (const s of t.segmentos) {
      for (const w of s.palabras || []) palabras.push({ word: w.word, start: w.start + acc, end: w.end + acc });
      for (const e of s.entradas || []) golpes.push(e + acc);
      acc += s.dur || 0;
    }
    // Si falta la transcripción de alguna parte, se transcribe el audio completo.
    if (t.segmentos.some((s) => !s.palabras)) {
      const mp3 = path.join(dir, 'todo.mp3');
      await ffmpeg(['-i', base, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', mp3]);
      palabras.length = 0;
      palabras.push(...await transcribir(mp3).catch(() => [] as Palabra[]));
    }
    const fuente = FUENTE_FUERTE.replace(/\\/g, '/').replace(/:/g, '\\:');
    const dib: string[] = [];
    for (const [i, s] of subtitulosPorPalabra(palabras).entries()) {
      const fl = await textoEnArchivo(dir, `s${i}`, s.texto);
      dib.push(`drawtext=fontfile='${fuente}':textfile='${fl}':fontsize=76:fontcolor=white:borderw=7:bordercolor=black@0.9:x=(w-tw)/2:y=h*0.64:enable='between(t,${s.desde.toFixed(2)},${s.hasta.toFixed(2)})'`);
    }
    const entradas = ['-i', base];
    const grafo: string[] = [`[0:v]${dib.length ? dib.join(',') : 'null'}[vs]`];
    let ultimo = '[vs]', idx = 1;
    const archivoLogo = await logo(path.join(dir, 'logo.png')).catch(() => null);
    if (archivoLogo) { entradas.push('-i', archivoLogo); grafo.push(`[${idx}:v]scale=150:-1,format=rgba,colorchannelmixer=aa=0.8[lg]`, `${ultimo}[lg]overlay=W-w-40:70[vl]`); ultimo = '[vl]'; idx++; }

    // Efecto de sonido ("whoosh") cada vez que entra una escena.
    const mezcla: string[] = ['[0:a]'];
    if (golpes.length) {
      const whoosh = path.join(dir, 'whoosh.wav');
      await ffmpeg(['-f', 'lavfi', '-i', 'anoisesrc=d=0.55:c=pink:a=0.6', '-af', 'highpass=f=300,lowpass=f=6000,afade=t=in:d=0.22,afade=t=out:st=0.25:d=0.3,volume=0.9', '-ar', '44100', '-ac', '2', whoosh]);
      entradas.push('-i', whoosh);
      grafo.push(`[${idx}:a]asplit=${golpes.length}${golpes.map((_, i) => `[w${i}]`).join('')}`);
      golpes.forEach((g, i) => { const ms = Math.max(0, Math.round((g - 0.12) * 1000)); grafo.push(`[w${i}]adelay=${ms}|${ms}[wd${i}]`); mezcla.push(`[wd${i}]`); });
      idx++;
    }
    // Música bajita de fondo (de la carpeta de Theo).
    let cancion = '';
    try {
      const tema = path.join(dir, 'musica.mp3');
      cancion = (await cancionAlAzar(tema, 'background music')).replace(/\.[^.]+$/, '');
      entradas.push('-stream_loop', '-1', '-i', tema);
      grafo.push(`[${idx}:a]volume=0.07,afade=t=in:d=1[m]`); mezcla.push('[m]'); idx++;
    } catch { /* sin música */ }
    grafo.push(`${mezcla.join('')}amix=inputs=${mezcla.length}:duration=first:dropout_transition=0:normalize=0,afade=t=out:st=${Math.max(0, total - 1).toFixed(2)}:d=1[am]`);

    const final = path.join(dir, 'final.mp4');
    // El almacenamiento acepta hasta 50 MB: tope de bitrate según la duración (con margen).
    const tope = Math.max(2500, Math.min(9000, Math.floor((44 * 8 * 1024) / total) - 170));
    await ffmpeg([...entradas, '-filter_complex', grafo.join(';'), '-map', ultimo, '-map', '[am]', '-t', total.toFixed(2),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-maxrate', `${tope}k`, '-bufsize', `${tope * 2}k`, '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', final], 280000);

    const nombre = `reels/historia-${Date.now()}.mp4`;
    const url = await subirPublicacion(final, nombre);
    const enDrive = await guardarEnDrive(final, t.titulo);
    await db().from('publicaciones').insert({ tipo: 'reel', reloj: t.titulo, archivo: nombre, estado: 'para aprobar' });
    await db().from('guiones').update({ estado: 'editado', actualizado: new Date().toISOString() }).eq('id', t.guionId);
    const texto = [
      `Theo — video de historia listo (${Math.round(total)} s, ${t.segmentos.filter((s) => s.tipo === 'camara').length} partes a cámara y ${t.segmentos.filter((s) => s.tipo === 'off').length} de voz en off, ${golpes.length} escenas)`,
      t.titulo, `Ver video: ${url}`, enDrive,
      cancion ? `Música de fondo: ${cancion}` : '',
      ...t.avisos,
      t.caption ? `\nTexto que se publica:\n${t.caption}` : '',
    ].filter(Boolean).join('\n');
    const id = await crearAprobacion('theo', texto, 'reel', { guionId: t.guionId, url, caption: t.caption, musica: 'sin' });
    const msg = await enviarConBotones(texto, t.caption
      ? [{ texto: 'Publicar', dato: `apr:${id}:si` }, { texto: 'Lo publico yo', dato: `apr:${id}:no` }]
      : [{ texto: 'Lo publico yo', dato: `apr:${id}:no` }]);
    if (msg) await db().from('aprobaciones').update({ telegram_msg_id: msg }).eq('id', id);
    await setAhora('theo', 'Video de historia listo: espera tu aprobación.', 'wait');
    await db().storage.from('publicaciones').remove(t.segmentos.map((s) => s.hecho!).filter(Boolean)).catch(() => {});
    return url;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
