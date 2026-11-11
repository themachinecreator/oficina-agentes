import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import ffmpegPath from 'ffmpeg-static';
import { db } from './db';
import { descargarDrive, listarDrive } from './google';
import { carpetaRaiz } from './fotos';

const FUENTES = path.join(process.cwd(), 'assets', 'fonts');
export const FUENTE_FUERTE = path.join(FUENTES, 'Jost-SemiBold.ttf');
export const FUENTE_NORMAL = path.join(FUENTES, 'Jost-Regular.ttf');

export function ffmpeg(args: string[], timeoutMs = 240000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg no está disponible.'));
    const p = spawn(ffmpegPath as unknown as string, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg tardó demasiado.')); }, timeoutMs);
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`ffmpeg falló: ${err.slice(-400)}`)); });
  });
}

// Igual que ffmpeg() pero devuelve lo que ffmpeg informa (para detectar silencios y duraciones).
export function ffmpegInfo(args: string[], timeoutMs = 120000): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath as unknown as string, ['-hide_banner', ...args]);
    let salida = '';
    p.stderr.on('data', (d) => { salida += d.toString(); });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', () => { clearTimeout(t); resolve(salida); });
  });
}

export async function duracionYAudio(archivo: string) {
  const info = await ffmpegInfo(['-i', archivo]);
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
  const dur = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  return { dur, audio: /Stream #.*Audio:/.test(info) };
}

export async function carpetaTemporal() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'theo-'));
}

export async function bajarDeDrive(id: string, destino: string) {
  const r = await descargarDrive(id);
  if (!r.ok) throw new Error(`No pude bajar el archivo ${id} del Drive (${r.status}).`);
  await fs.writeFile(destino, Buffer.from(await r.arrayBuffer()));
  return destino;
}

// Carpeta "Música Theo": canciones libres de derechos que subió Beltrán (y su logo).
async function carpetaMusica() {
  const { data } = await db().from('credenciales').select('valor').eq('clave', 'musica_carpeta_id').maybeSingle();
  if (data?.valor) return data.valor;
  const raiz = await carpetaRaiz();
  const r = (await listarDrive(`${raiz ? `'${raiz}' in parents and ` : ''}mimeType = 'application/vnd.google-apps.folder' and trashed = false`))
    .filter((f: any) => /m[uú]sica/i.test(f.name));
  if (!r.length) return '';
  await db().from('credenciales').upsert({ clave: 'musica_carpeta_id', valor: r[0].id, actualizado: new Date().toISOString() });
  return r[0].id;
}

export async function cancionAlAzar(destino: string) {
  const carpeta = await carpetaMusica();
  if (!carpeta) throw new Error('Falta la carpeta "Música Theo" en el Drive.');
  const temas = await listarDrive(`'${carpeta}' in parents and trashed = false and (mimeType contains 'audio/')`);
  if (!temas.length) throw new Error('La carpeta "Música Theo" no tiene canciones.');
  const t = temas[Math.floor(Math.random() * temas.length)];
  await bajarDeDrive(t.id, destino);
  return t.name as string;
}

// Logo: un PNG suelto en la carpeta Watches (o dentro de la de música). Si hay varios, el que se llame "logo".
export async function logo(destino: string) {
  const lugares = [await carpetaRaiz(), await carpetaMusica()].filter(Boolean);
  for (const c of lugares) {
    const r = await listarDrive(`'${c}' in parents and trashed = false and mimeType = 'image/png'`);
    if (r.length) return bajarDeDrive((r.find((f: any) => /logo/i.test(f.name)) || r[0]).id, destino);
  }
  return null;
}

export async function subirPublicacion(archivo: string, nombre: string, tipo = 'video/mp4') {
  const datos = await fs.readFile(archivo);
  const { error } = await db().storage.from('publicaciones').upload(nombre, datos, { contentType: tipo, upsert: true });
  if (error) throw new Error(`No pude guardar el video: ${error.message}`);
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/publicaciones/${nombre}`;
}

// Escapa texto para el filtro drawtext usando archivos (evita problemas con comillas y dos puntos).
export async function textoEnArchivo(dir: string, nombre: string, texto: string) {
  const f = path.join(dir, `${nombre}.txt`);
  await fs.writeFile(f, texto, 'utf8');
  return f.replace(/\\/g, '/').replace(/:/g, '\\:');
}
