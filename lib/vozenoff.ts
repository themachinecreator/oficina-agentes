import path from 'path';
import { promises as fs } from 'fs';
import { db, setAhora } from './db';
import { listarDrive, jpegDeDrive } from './google';
import { carpetaRaiz } from './fotos';
import {
  ffmpeg, duracionYAudio, filtroHdr, carpetaTemporal, bajarDeDrive, cancionAlAzar, logo, normalizar,
  subirPublicacion, guardarEnDrive, textoEnArchivo, FUENTE_FUERTE,
} from './video';
import { enviarConBotones, avisar } from './telegram';
import { crearAprobacion } from './aprobaciones';
import { transcribir, subtitulosPorPalabra } from './historia';
import { leerGuion } from './reel';

// ---------- Reel con voz en off: audios por toma (carpeta "Voz") sobre tomas de video (carpeta "Videos") ----------
const numero = (n: string) => { const m = /(\d+)/.exec(n); return m ? Number(m[1]) : 999; };

async function carpetas(guionId?: number) {
  const raiz = await carpetaRaiz();
  const base = (await listarDrive(`${raiz ? `'${raiz}' in parents and ` : ''}mimeType = 'application/vnd.google-apps.folder' and trashed = false`))
    .find((f: any) => /para\s+editar/i.test(f.name));
  if (!base) throw new Error('No encontré la carpeta de videos para editar.');
  let padre = base.id;
  const subs = await listarDrive(`'${base.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  if (guionId) {
    const g = subs.find((s: any) => new RegExp(`\\b${guionId}\\b`).test(s.name));
    if (g) padre = g.id;
  }
  const dentro = padre === base.id ? subs : await listarDrive(`'${padre}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const voz = dentro.find((s: any) => /^voz|voces|audio/i.test(s.name));
  const videos = dentro.find((s: any) => /^video|tomas|im[aá]genes/i.test(s.name));
  if (!voz || !videos) throw new Error('Necesito dos carpetas: "Voz" (los audios por toma) y "Videos" (las tomas).');
  const audios = (await listarDrive(`'${voz.id}' in parents and trashed = false and mimeType contains 'audio/'`, 'files(id,name,mimeType)'))
    .sort((a: any, b: any) => numero(a.name) - numero(b.name));
  const clips = (await listarDrive(`'${videos.id}' in parents and trashed = false and mimeType contains 'video/'`, 'files(id,name,mimeType,createdTime)'))
    .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  // Fotos para intercalar: sueltas en la carpeta del guion o en una subcarpeta "Fotos".
  // El nombre de cada foto es la palabra en la que aparece (por ejemplo "royal oak.jpg").
  const fotosDir = dentro.find((s: any) => /^fotos?$/i.test(String(s.name).trim()));
  const fotos: any[] = [];
  for (const c of [padre, fotosDir?.id].filter(Boolean)) {
    fotos.push(...await listarDrive(`'${c}' in parents and trashed = false and mimeType contains 'image/'`, 'files(id,name,mimeType)'));
  }
  if (!audios.length) throw new Error('La carpeta "Voz" no tiene audios.');
  if (!clips.length) throw new Error('La carpeta "Videos" no tiene videos.');
  return { audios, clips, fotos };
}

export async function editarVozEnOff(op: { guionId?: number; musica?: 'libre' | 'sin'; cancion?: string } = {}) {
  const { audios, clips, fotos } = await carpetas(op.guionId);
  let caption = '', titulo = 'Reel con voz en off';
  if (op.guionId) {
    const { data: g } = await db().from('guiones').select('titulo, contenido').eq('id', op.guionId).maybeSingle();
    if (g) { caption = leerGuion(g.contenido).caption; titulo = g.titulo; }
  }
  await setAhora('theo', `Armando el reel con voz en off (${audios.length} audios, ${clips.length} tomas).`, 'ok');
  const dir = await carpetaTemporal();
  try {
    // 1) Voz: cada audio recortado de silencios en los bordes, unidos con una pausa corta, y transcriptos con tiempos.
    const partes: string[] = [];
    const palabras: { word: string; start: number; end: number }[] = [];
    let t = 0;
    for (const [i, a] of audios.entries()) {
      const orig = await bajarDeDrive(a.id, path.join(dir, `voz${i}`));
      const limpio = path.join(dir, `voz${i}.wav`);
      await ffmpeg(['-i', orig, '-af', 'silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.1,areverse,silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.15,areverse,apad=pad_dur=0.25', '-ar', '44100', '-ac', '2', limpio]);
      const { dur } = await duracionYAudio(limpio);
      const mp3 = path.join(dir, `voz${i}.mp3`);
      await ffmpeg(['-i', limpio, '-ac', '1', '-ar', '16000', '-b:a', '48k', mp3]);
      const ws = await transcribir(mp3).catch(() => []);
      for (const w of ws) palabras.push({ word: w.word, start: w.start + t, end: w.end + t });
      partes.push(limpio);
      t += dur;
    }
    const total = t;
    const lista = path.join(dir, 'voz.txt');
    await fs.writeFile(lista, partes.map((p) => `file '${p}'`).join('\n'));
    const voz = path.join(dir, 'voz.wav');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', voz]);

    // 2) Tomas: cortes de ~3 s que van rotando entre los videos; cada video avanza para no repetir la misma parte.
    const fuentes: { archivo: string; dur: number; hdr: string; pos: number }[] = [];
    for (const [i, c] of clips.entries()) {
      const archivo = await bajarDeDrive(c.id, path.join(dir, `clip${i}`));
      const { dur } = await duracionYAudio(archivo);
      fuentes.push({ archivo, dur, hdr: await filtroHdr(archivo), pos: Math.min(0.4, dur / 4) });
    }
    const cortes: string[] = [];
    let k = 0, cursor = 0;
    while (cursor < total - 0.05) {
      const largo = Math.min(total - cursor < 4 ? total - cursor : 3, total - cursor);
      const f = fuentes[k % fuentes.length];
      if (f.pos + largo > f.dur) f.pos = Math.max(0, (f.dur - largo) * 0.1);
      const salida = path.join(dir, `corte${cortes.length}.mp4`);
      await ffmpeg(['-ss', f.pos.toFixed(2), '-t', largo.toFixed(2), '-i', f.archivo,
        '-vf', `${f.hdr}scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,fps=30,setsar=1`,
        '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '17', salida]);
      f.pos += largo;
      cortes.push(salida);
      cursor += largo;
      k++;
    }
    const listaV = path.join(dir, 'cortes.txt');
    await fs.writeFile(listaV, cortes.map((p) => `file '${p}'`).join('\n'));
    const base = path.join(dir, 'base.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listaV, '-c', 'copy', base]);
    for (const f of fuentes) await fs.rm(f.archivo, { force: true });

    // 3) Montaje: subtítulos palabra por palabra, logo, voz y música opcional.
    const fuente = FUENTE_FUERTE.replace(/\\/g, '/').replace(/:/g, '\\:');
    const dib: string[] = [];
    for (const [i, s] of subtitulosPorPalabra(palabras).entries()) {
      const fl = await textoEnArchivo(dir, `s${i}`, s.texto);
      dib.push(`drawtext=fontfile='${fuente}':textfile='${fl}':fontsize=76:fontcolor=white:borderw=7:bordercolor=black@0.9:x=(w-tw)/2:y=h*0.64:enable='between(t,${s.desde.toFixed(2)},${s.hasta.toFixed(2)})'`);
    }
    const entradas = ['-i', base, '-i', voz];
    const grafo: string[] = [];
    let ultimo = '[0:v]', idx = 2;
    // Fotos intercaladas: aparecen a pantalla completa cuando la voz dice su nombre (unos 2,5 s).
    const sinFoto: string[] = [], conFoto: string[] = [];
    const dichas = palabras.map((w) => normalizar(w.word));
    for (const [i, f] of fotos.entries()) {
      const clave = normalizar(String(f.name).replace(/\.[^.]+$/, '')).replace(/\s*\d+$/, '').split(' ').filter(Boolean);
      if (!clave.length) continue;
      // Todas las veces que se dice (con "ROYALOAK.jpg" alcanza con que diga "Royal").
      const coincide = (c: string, d?: string) => !!d && (d.startsWith(c) || (d.length >= 4 && c.startsWith(d)));
      const tramos: { desde: number; hasta: number }[] = [];
      for (let j = 0; j + clave.length <= dichas.length; j++) {
        if (!clave.every((c, k) => coincide(c, dichas[j + k]))) continue;
        const desde = Math.max(0, palabras[j].start - 0.15);
        if (tramos.length && desde < tramos[tramos.length - 1].hasta + 1) continue;
        tramos.push({ desde, hasta: Math.min(total, Math.max(desde + 2.5, palabras[j + clave.length - 1].end + 0.8)) });
      }
      if (!tramos.length) { sinFoto.push(f.name); continue; }
      const crudo = path.join(dir, `foto${i}`), jpg = path.join(dir, `foto${i}.jpg`);
      try {
        await bajarDeDrive(f.id, crudo);
        await ffmpeg(['-i', crudo, '-frames:v', '1', '-vf', "scale='min(2000,iw)':-2", '-q:v', '2', jpg]);
      } catch {
        await fs.writeFile(jpg, await jpegDeDrive(f.id, 2000));
      }
      entradas.push('-loop', '1', '-t', total.toFixed(2), '-i', jpg);
      grafo.push(
        `[${idx}:v]split[f${i}a][f${i}b]`,
        `[f${i}a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:2,eq=brightness=-0.12[f${i}fondo]`,
        `[f${i}b]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos[f${i}frente]`,
        `[f${i}fondo][f${i}frente]overlay=(W-w)/2:(H-h)/2,fps=30,format=yuv420p,setsar=1[f${i}]`,
        `${ultimo}[f${i}]overlay=0:0:enable='${tramos.map((x) => `between(t,${x.desde.toFixed(2)},${x.hasta.toFixed(2)})`).join('+')}'[cf${i}]`,
      );
      ultimo = `[cf${i}]`; idx++;
      conFoto.push(`${String(f.name).replace(/\.[^.]+$/, '')} (${tramos.map((x) => `${x.desde.toFixed(1)} s`).join(', ')})`);
    }
    grafo.push(`${ultimo}${dib.length ? dib.join(',') : 'null'}[vs]`);
    ultimo = '[vs]';
    const archivoLogo = await logo(path.join(dir, 'logo.png')).catch(() => null);
    if (archivoLogo) { entradas.push('-i', archivoLogo); grafo.push(`[${idx}:v]scale=150:-1,format=rgba,colorchannelmixer=aa=0.8[lg]`, `${ultimo}[lg]overlay=W-w-40:70[vl]`); ultimo = '[vl]'; idx++; }
    let audio = '[1:a]', cancionUsada = '';
    if (op.musica === 'libre') {
      const tema = path.join(dir, 'musica.mp3');
      const elegida = await cancionAlAzar(tema, op.cancion);
      cancionUsada = elegida.replace(/\.[^.]+$/, '');
      entradas.push('-stream_loop', '-1', '-i', tema);
      grafo.push(`[${idx}:a]volume=0.1,afade=t=in:d=1[m]`, `[1:a][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,afade=t=out:st=${Math.max(0, total - 1.2).toFixed(2)}:d=1.2[am]`);
      audio = '[am]';
    }
    const final = path.join(dir, 'final.mp4');
    await ffmpeg([...entradas, '-filter_complex', grafo.join(';'), '-map', ultimo, '-map', audio, '-t', total.toFixed(2),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-maxrate', '12M', '-bufsize', '24M', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', final], 280000);

    const nombre = `reels/vozenoff-${Date.now()}.mp4`;
    const url = await subirPublicacion(final, nombre);
    const enDrive = await guardarEnDrive(final, titulo);
    await db().from('publicaciones').insert({ tipo: 'reel', reloj: titulo, archivo: nombre, estado: 'para aprobar' });
    if (op.guionId) await db().from('guiones').update({ estado: 'editado', actualizado: new Date().toISOString() }).eq('id', op.guionId);
    const texto = [
      `Theo — reel con voz en off listo (${Math.round(total)} s, ${audios.length} audios sobre ${clips.length} tomas, ${cortes.length} cortes)`,
      titulo, `Ver video: ${url}`, enDrive,
      cancionUsada ? `Música: ${cancionUsada}` : '',
      conFoto.length ? `Fotos intercaladas: ${conFoto.join(', ')}` : '',
      sinFoto.length ? `No encontré en la voz dónde va: ${sinFoto.join(', ')} (el nombre de la foto tiene que ser la palabra que decís).` : '',
      palabras.length ? '' : '\n(No pude transcribir la voz: va sin subtítulos.)',
      caption ? `\nTexto que se publica:\n${caption}` : '',
    ].filter(Boolean).join('\n');
    const id = await crearAprobacion('theo', texto, 'reel', { guionId: op.guionId || null, url, caption, musica: op.musica === 'libre' ? 'libre' : 'sin' });
    const msg = await enviarConBotones(texto, caption
      ? [{ texto: 'Publicar', dato: `apr:${id}:si` }, { texto: 'Lo publico yo', dato: `apr:${id}:no` }]
      : [{ texto: 'Lo publico yo', dato: `apr:${id}:no` }]);
    if (msg) await db().from('aprobaciones').update({ telegram_msg_id: msg }).eq('id', id);
    await setAhora('theo', 'Reel con voz en off listo: espera tu aprobación.', 'wait');
    return url;
  } catch (e: any) {
    await setAhora('theo', 'No pudo armar el reel con voz en off.', 'idle');
    await avisar(`Theo no pudo armar el reel con voz en off: ${e.message}`);
    throw e;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
