import path from 'path';
import { promises as fs } from 'fs';
import { db, setAhora } from './db';
import { listarDrive } from './google';
import {
  ffmpeg, ffmpegInfo, duracionYAudio, filtroHdr, carpetaTemporal, bajarDeDrive, cancionAlAzar, logo,
  subirPublicacion, textoEnArchivo, FUENTE_FUERTE,
} from './video';
import { enviarConBotones, avisar } from './telegram';
import { crearAprobacion } from './aprobaciones';
import { carpetaTomas, leerGuion } from './reel';
import { stockDisponible, carpetaDelReloj } from './stock';

// ---------- Video de historia: Beltrán a cámara + voz en off sobre apoyos, subtítulos palabra por palabra ----------

export type Apoyo = { id: string; desc: string; fuente: 'DRIVE' | 'ARCHIVO' | 'IA' | string; ref: string };
export type Tramo = { tipo: 'camara' | 'off'; texto: string; apoyos: Apoyo[] };
type Palabra = { word: string; start: number; end: number };

export function leerHistoria(contenido: string) {
  const lineas = contenido.split('\n').map((l) => l.trim());
  const tramos: Tramo[] = [];
  let actual: Tramo | null = null;
  const fin = /^(texto de la publicaci[oó]n|hashtags|qu[eé] conseguir|qu[eé] grabar|para theo)\b/i;
  for (const l of lineas) {
    if (fin.test(l)) { actual = null; continue; }
    const t = /^\[\s*(A C[ÁA]MARA|VOZ EN OFF)\s*\]/i.exec(l);
    if (t) { actual = { tipo: /off/i.test(t[1]) ? 'off' : 'camara', texto: '', apoyos: [] }; tramos.push(actual); continue; }
    const a = /^APOYO\s+(B\d+)\s*:\s*(.*?)\s*\|\s*(DRIVE|ARCHIVO|IA)\s*:\s*(.*)$/i.exec(l);
    if (a && actual) { actual.apoyos.push({ id: a[1].toUpperCase(), desc: a[2], fuente: a[3].toUpperCase(), ref: a[4] }); continue; }
    if (actual && l && /^[“"«]/.test(l)) actual.texto = `${actual.texto} ${l.replace(/^[“"«]|[”"»]$/g, '')}`.trim();
  }
  return tramos.filter((t) => t.texto);
}

const normal = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter(Boolean);

async function claveGroq() {
  const { data } = await db().from('credenciales').select('valor').eq('clave', 'groq_key').maybeSingle();
  return data?.valor || process.env.GROQ_API_KEY || '';
}

// Transcribe con tiempos por palabra (Whisper en Groq).
export async function transcribir(audio: string): Promise<Palabra[]> {
  const key = await claveGroq();
  if (!key) throw new Error('Falta la clave de Groq para transcribir.');
  const f = new FormData();
  f.append('file', new Blob([new Uint8Array(await fs.readFile(audio))], { type: 'audio/mpeg' }), 'audio.mp3');
  f.append('model', 'whisper-large-v3');
  f.append('language', 'es');
  f.append('response_format', 'verbose_json');
  f.append('timestamp_granularities[]', 'word');
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: f });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Transcripción: ${d?.error?.message || r.status}`);
  return (d.words || []).map((w: any) => ({ word: String(w.word).trim(), start: Number(w.start), end: Number(w.end) })).filter((w: Palabra) => w.word);
}

// Tramos de habla: junta palabras separadas por menos de `hueco` segundos (corta silencios y titubeos largos).
export function tramosDeHabla(p: Palabra[], dur: number, hueco = 0.55, margen = 0.12) {
  const out: { a: number; b: number }[] = [];
  for (const w of p) {
    const a = Math.max(0, w.start - margen), b = Math.min(dur, w.end + margen);
    const u = out[out.length - 1];
    if (u && a - u.b < hueco) u.b = Math.max(u.b, b); else out.push({ a, b });
  }
  return out.filter((t) => t.b - t.a > 0.15);
}

// Tiempo original -> tiempo en el video ya cortado.
export function mapear(t: number, tramos: { a: number; b: number }[]) {
  let acc = 0;
  for (const x of tramos) {
    if (t < x.a) return acc;
    if (t <= x.b) return acc + (t - x.a);
    acc += x.b - x.a;
  }
  return acc;
}

// Ubica cada tramo del guion en la transcripción: reparte por proporción de palabras y ajusta buscando la primera palabra.
export function alinear(tramos: Tramo[], palabras: Palabra[]) {
  const totalGuion = tramos.reduce((s, t) => s + normal(t.texto).length, 0) || 1;
  const pal = palabras.map((p) => normal(p.word)[0] || '');
  const n = palabras.length;
  let acum = 0;
  const inicios: number[] = [];
  for (const t of tramos) {
    let i = Math.round((acum / totalGuion) * n);
    const primera = normal(t.texto)[0];
    if (primera && inicios.length) {
      for (let d = 0; d <= 8; d++) {
        if (pal[i + d] === primera) { i += d; break; }
        if (i - d > (inicios[inicios.length - 1] ?? 0) && pal[i - d] === primera) { i -= d; break; }
      }
    }
    inicios.push(Math.min(Math.max(i, inicios[inicios.length - 1] ?? 0), n - 1));
    acum += normal(t.texto).length;
  }
  return tramos.map((t, k) => {
    const a = inicios[k], b = (k + 1 < inicios.length ? inicios[k + 1] : n) - 1;
    return { ...t, desde: palabras[a]?.start ?? 0, hasta: palabras[Math.max(a, b)]?.end ?? 0 };
  });
}

// Subtítulos de 1 a 3 palabras, cortando en la puntuación.
export function subtitulosPorPalabra(p: Palabra[]) {
  const out: { texto: string; desde: number; hasta: number }[] = [];
  let grupo: Palabra[] = [];
  const cerrar = () => { if (grupo.length) out.push({ texto: grupo.map((w) => w.word).join(' ').replace(/\s+([,.;:!?])/g, '$1'), desde: grupo[0].start, hasta: grupo[grupo.length - 1].end }); grupo = []; };
  for (const w of p) {
    grupo.push(w);
    if (grupo.length >= 3 || /[.,;:!?]$/.test(w.word) || grupo.map((x) => x.word).join(' ').length > 16) cerrar();
  }
  cerrar();
  for (let i = 0; i < out.length - 1; i++) out[i].hasta = Math.max(out[i].hasta, Math.min(out[i + 1].desde, out[i].hasta + 0.4));
  return out;
}

export async function editarHistoria(guionId: number, op: { musica?: 'libre' | 'sin' } = {}) {
  const { data: g } = await db().from('guiones').select('id, titulo, contenido').eq('id', guionId).maybeSingle();
  if (!g) throw new Error(`No encontré el guion #${guionId}.`);
  const tramos = leerHistoria(g.contenido);
  if (!tramos.length) throw new Error(`El guion #${guionId} no tiene el formato de historia ([A CÁMARA] / [VOZ EN OFF]).`);
  const { caption } = leerGuion(g.contenido);

  // Carpeta del guion: la toma principal (el video más pesado que no se llame B…) y los apoyos B1, B2…
  const base = await listarDrive(`name contains 'para editar' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const subs = base.length ? await listarDrive(`'${base[0].id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`) : [];
  const c = subs.find((s: any) => new RegExp(`\\b${guionId}\\b`).test(s.name));
  if (!c) throw new Error(`No encontré la carpeta "Guion ${guionId}" dentro de "Videos para editar".`);
  const archivos = await listarDrive(`'${c.id}' in parents and trashed = false and (mimeType contains 'video/' or mimeType contains 'image/')`, 'files(id,name,mimeType,size)');
  const esApoyo = (n: string) => /^\s*b\d+/i.test(n);
  const principal = archivos.filter((f: any) => !esApoyo(f.name) && String(f.mimeType).startsWith('video/')).sort((a: any, b: any) => Number(b.size || 0) - Number(a.size || 0))[0];
  if (!principal) throw new Error(`Falta la toma principal (el video grabado) en "Guion ${guionId}".`);
  const subidos = new Map<string, any>();
  for (const f of archivos) { const m = /^\s*(b\d+)/i.exec(f.name); if (m) subidos.set(m[1].toUpperCase(), f); }

  await setAhora('theo', `Editando el video de historia del guion #${guionId}.`, 'ok');
  const dir = await carpetaTemporal();
  try {
    // 1) Toma principal, audio y transcripción.
    const original = await bajarDeDrive(principal.id, path.join(dir, 'principal'));
    const { dur } = await duracionYAudio(original);
    const mp3 = path.join(dir, 'audio.mp3');
    await ffmpeg(['-i', original, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', mp3]);
    const palabras = await transcribir(mp3);
    if (palabras.length < 5) throw new Error('No se entiende el audio de la toma (¿está sin sonido?).');

    // 2) Cortes de silencio y video vertical 1080x1920 a 30 cuadros.
    const habla = tramosDeHabla(palabras, dur);
    const hdr = await filtroHdr(original);
    const cortes = habla.map((t, i) => `[0:v]trim=${t.a.toFixed(3)}:${t.b.toFixed(3)},setpts=PTS-STARTPTS[v${i}];[0:a]atrim=${t.a.toFixed(3)}:${t.b.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`).join(';');
    const concat = `${habla.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${habla.length}:v=1:a=1[vc][ac]`;
    const vertical = `[vc]${hdr}scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,fps=30,setsar=1[vout]`;
    const cortado = path.join(dir, 'cortado.mp4');
    await ffmpeg(['-i', original, '-filter_complex', `${cortes};${concat};${vertical}`, '-map', '[vout]', '-map', '[ac]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '17', '-c:a', 'aac', '-b:a', '192k', cortado], 280000);
    await fs.rm(original, { force: true });
    const total = habla.reduce((s, t) => s + (t.b - t.a), 0);
    const pal2 = palabras.map((w) => ({ word: w.word, start: mapear(w.start, habla), end: mapear(w.end, habla) }));

    // 3) Apoyos: ubicar cada tramo de voz en off y repartir su tiempo entre sus apoyos.
    const ubicados = alinear(tramos, pal2);
    const stock = await stockDisponible().catch(() => []);
    const faltan: string[] = [];
    const capas: { archivo: string; desde: number; hasta: number; esVideo: boolean }[] = [];
    let n = 0;
    for (const t of ubicados) {
      if (t.tipo !== 'off' || !t.apoyos.length || t.hasta - t.desde < 0.6) continue;
      const paso = (t.hasta - t.desde) / t.apoyos.length;
      for (const [k, ap] of t.apoyos.entries()) {
        let fuente: { id: string; esVideo: boolean } | null = null;
        const sub = subidos.get(ap.id);
        if (sub) fuente = { id: sub.id, esVideo: String(sub.mimeType).startsWith('video/') };
        else if (ap.fuente === 'DRIVE') {
          const palabrasRef = normal(ap.ref);
          const r = stock.find((x) => palabrasRef.filter((w) => normal(`${x['Marca']} ${x['Modelo']} ${x['Referencia'] || ''}`).includes(w)).length >= 2);
          const cr = r && carpetaDelReloj(r);
          if (cr) {
            const usados = capas.length;
            const fotos = cr.fotos || [], videos = cr.videos || [];
            if (videos.length && k % 2 === 0) fuente = { id: videos[usados % videos.length], esVideo: true };
            else if (fotos.length) fuente = { id: fotos[usados % fotos.length], esVideo: false };
          }
        }
        if (!fuente) { faltan.push(`${ap.id} (${ap.fuente.toLowerCase()}: ${ap.desc})`); continue; }
        const destino = await bajarDeDrive(fuente.id, path.join(dir, `apoyo${n++}`));
        capas.push({ archivo: destino, desde: t.desde + k * paso, hasta: t.desde + (k + 1) * paso, esVideo: fuente.esVideo });
      }
    }

    // 4) Cada apoyo como clip vertical de su duración (si es horizontal, completo sobre fondo desenfocado).
    const clips: { archivo: string; desde: number; hasta: number }[] = [];
    for (const [i, cp] of capas.entries()) {
      const largo = Math.max(0.5, cp.hasta - cp.desde);
      const info = await ffmpegInfo(['-i', cp.archivo]);
      const m = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(info);
      const w = m ? Number(m[1]) : 1080, h = m ? Number(m[2]) : 1920;
      const vertical = w / h < 0.7;
      const h2 = cp.esVideo ? await filtroHdr(cp.archivo) : '';
      const zoom = cp.esVideo ? '' : `,zoompan=z='min(zoom+0.0012,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.ceil(largo * 30)}:s=1080x1920:fps=30`;
      const filtro = vertical
        ? `[0:v]${h2}scale=1240:2204:force_original_aspect_ratio=increase,crop=1240:2204${zoom || ',scale=1080:1920'},setsar=1,fps=30[v]`
        : `[0:v]${h2}split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=40:6,eq=brightness=-0.15[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2${zoom},setsar=1,fps=30[v]`;
      const salida = path.join(dir, `clip${i}.mp4`);
      const entrada = cp.esVideo ? ['-stream_loop', '-1', '-i', cp.archivo] : ['-loop', '1', '-i', cp.archivo];
      await ffmpeg([...entrada, '-filter_complex', filtro, '-map', '[v]', '-t', largo.toFixed(2), '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', salida]);
      await fs.rm(cp.archivo, { force: true });
      clips.push({ archivo: salida, desde: cp.desde, hasta: cp.hasta });
    }

    // 5) Montaje final: apoyos encima, subtítulos palabra por palabra, logo y música opcional.
    const entradas = ['-i', cortado];
    const grafo: string[] = [];
    let actual = '[0:v]';
    clips.forEach((cl, i) => {
      entradas.push('-i', cl.archivo);
      grafo.push(`[${i + 1}:v]setpts=PTS-STARTPTS+${cl.desde.toFixed(3)}/TB[c${i}]`, `${actual}[c${i}]overlay=0:0:enable='between(t,${cl.desde.toFixed(3)},${cl.hasta.toFixed(3)})':eof_action=pass[o${i}]`);
      actual = `[o${i}]`;
    });
    const fuente = FUENTE_FUERTE.replace(/\\/g, '/').replace(/:/g, '\\:');
    const subts = subtitulosPorPalabra(pal2);
    const dibujos: string[] = [];
    for (const [i, s] of subts.entries()) {
      const f = await textoEnArchivo(dir, `s${i}`, s.texto);
      dibujos.push(`drawtext=fontfile='${fuente}':textfile='${f}':fontsize=76:fontcolor=white:borderw=7:bordercolor=black@0.9:x=(w-tw)/2:y=h*0.64:enable='between(t,${s.desde.toFixed(2)},${s.hasta.toFixed(2)})'`);
    }
    grafo.push(`${actual}${dibujos.length ? dibujos.join(',') : 'null'}[vs]`);
    let ultimo = '[vs]';
    let idx = clips.length + 1;
    const archivoLogo = await logo(path.join(dir, 'logo.png')).catch(() => null);
    if (archivoLogo) { entradas.push('-i', archivoLogo); grafo.push(`[${idx}:v]scale=150:-1,format=rgba,colorchannelmixer=aa=0.8[lg]`, `${ultimo}[lg]overlay=W-w-40:70[vl]`); ultimo = '[vl]'; idx++; }
    let audio = '[0:a]';
    if (op.musica === 'libre') {
      const tema = path.join(dir, 'musica.mp3');
      await cancionAlAzar(tema);
      entradas.push('-stream_loop', '-1', '-i', tema);
      grafo.push(`[${idx}:a]volume=0.08,afade=t=in:d=1[m]`, `[0:a][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,afade=t=out:st=${Math.max(0, total - 1.2).toFixed(2)}:d=1.2[am]`);
      audio = '[am]';
      idx++;
    }
    const final = path.join(dir, 'final.mp4');
    await ffmpeg([...entradas, '-filter_complex', grafo.join(';'), '-map', ultimo, '-map', audio, '-t', total.toFixed(2),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-maxrate', '12M', '-bufsize', '24M', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', final], 280000);

    const nombre = `reels/historia-${guionId}-${Date.now()}.mp4`;
    const url = await subirPublicacion(final, nombre);
    await db().from('publicaciones').insert({ tipo: 'reel', reloj: g.titulo, archivo: nombre, estado: 'para aprobar' });
    await db().from('guiones').update({ estado: 'editado', actualizado: new Date().toISOString() }).eq('id', guionId);
    const texto = [
      `Theo — video de historia del guion #${guionId} listo (${Math.round(total)} s, cortó ${Math.round(dur - total)} s de silencios)`,
      g.titulo, `Ver video: ${url}`,
      faltan.length ? `\nApoyos que no encontré (quedó tu imagen a cámara en esos tramos): ${faltan.join('; ')}. Si los subís a la carpeta con ese nombre, lo vuelvo a armar.` : '',
      `\nTexto que se publica:\n${caption || '(sin texto)'}`,
    ].filter(Boolean).join('\n');
    const id = await crearAprobacion('theo', texto, 'reel', { guionId, url, caption, musica: op.musica === 'libre' ? 'libre' : 'sin' });
    const botones = op.musica === 'libre'
      ? [{ texto: 'Publicar', dato: `apr:${id}:si` }, { texto: 'No publicar', dato: `apr:${id}:no` }]
      : [{ texto: 'Publicar', dato: `apr:${id}:si` }, { texto: 'Lo publico yo', dato: `apr:${id}:no` }];
    const msg = await enviarConBotones(texto, botones);
    if (msg) await db().from('aprobaciones').update({ telegram_msg_id: msg }).eq('id', id);
    await setAhora('theo', `Video de historia del guion #${guionId} listo: espera tu aprobación.`, 'wait');
    return { url, duracion: total, faltan };
  } catch (e: any) {
    await setAhora('theo', `No pudo editar la historia del guion #${guionId}.`, 'idle');
    await avisar(`Theo no pudo editar el video de historia del guion #${guionId}: ${e.message}`);
    throw e;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
