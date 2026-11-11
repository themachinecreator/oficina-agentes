import { db } from './db';
import { listarDrive } from './google';

// Carpeta "Fotos relojes" en el Drive de Beltrán: una subcarpeta por reloj con sus fotos y videos.
export type CarpetaReloj = { id: string; nombre: string; fotos: string[]; videos: string[] };
let cache: { cuando: number; carpetas: CarpetaReloj[]; raiz: string } | null = null;

export async function carpetaRaiz(): Promise<string> {
  const { data } = await db().from('credenciales').select('valor').eq('clave', 'fotos_carpeta_id').maybeSingle();
  if (data?.valor) return data.valor;
  const r = await listarDrive(`name = 'Fotos relojes' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  if (!r.length) return '';
  await db().from('credenciales').upsert({ clave: 'fotos_carpeta_id', valor: r[0].id, actualizado: new Date().toISOString() });
  return r[0].id;
}

export async function carpetasRelojes(): Promise<CarpetaReloj[]> {
  if (cache && Date.now() - cache.cuando < 5 * 60000) return cache.carpetas;
  const raiz = await carpetaRaiz();
  if (!raiz) return [];
  // Carpetas de trabajo que viven en el mismo Drive pero no son relojes.
  const especiales = /m[uú]sica|\btheo\b|videos para editar/i;
  const subs = (await listarDrive(`'${raiz}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`))
    .filter((s) => !especiales.test(String(s.name).trim()));
  const carpetas: CarpetaReloj[] = [];
  for (const s of subs) {
    const archivos = await listarDrive(`'${s.id}' in parents and trashed = false and (mimeType contains 'image/' or mimeType contains 'video/')`, 'files(id,name,mimeType,size)');
    // Primero el archivo más pesado: el original del celular antes que una copia comprimida (por ejemplo de WhatsApp).
    archivos.sort((a: any, b: any) => Number(b.size || 0) - Number(a.size || 0));
    const fotos = archivos.filter((a) => a.mimeType.startsWith('image/')).map((a) => a.id);
    const videos = archivos.filter((a) => a.mimeType.startsWith('video/')).map((a) => a.id);
    if (fotos.length || videos.length) carpetas.push({ id: s.id, nombre: s.name, fotos, videos });
  }
  cache = { cuando: Date.now(), carpetas, raiz };
  return carpetas;
}

// ¿El archivo está dentro de una subcarpeta de "Fotos relojes"? (para no exponer otros archivos del Drive)
export async function archivoPermitido(parents: string[] = []) {
  const carpetas = await carpetasRelojes();
  return parents.some((p) => carpetas.some((c) => c.id === p));
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ');
const palabras = (s: string) => norm(s).split(/\s+/).filter((w) => w.length > 1);
// Colores y términos en inglés que se usan en los nombres de las carpetas.
const SINONIMOS: Record<string, string> = {
  white: 'blanco', blanca: 'blanco', grey: 'gris', gray: 'gris', black: 'negro', negra: 'negro', blue: 'azul',
  green: 'verde', silver: 'plateado', plata: 'plateado', gold: 'dorado', champagne: 'champagne', brown: 'marron',
  red: 'rojo', yellow: 'amarillo', cuarzo: 'quartz', automatic: 'automatico', auto: 'automatico',
};
const canon = (w: string) => SINONIMOS[w] || w;

// Puntaje carpeta–reloj: referencia, marca y modelo, y atributos (movimiento, detalle, color) para desempatar piezas iguales.
function puntaje(nombreCarpeta: string, r: Record<string, string>) {
  const enCarpeta = new Set(palabras(nombreCarpeta).map(canon));
  const ref = norm(r['Referencia'] || '').trim();
  let p = 0;
  if (ref && ref.split(' ').every((w) => enCarpeta.has(w))) p += 10;
  const clave = palabras(`${r['Marca'] || ''} ${r['Modelo'] || ''}`).map(canon);
  const coinciden = clave.filter((w) => enCarpeta.has(w)).length;
  if (!p && coinciden < Math.min(2, clave.length)) return 0; // ni la referencia ni marca/modelo: no es este reloj
  p += coinciden;
  const atributos = new Set(palabras(`${r['Movimiento'] || ''} ${r['Detalle'] || ''} ${r['Material'] || ''}`).map(canon));
  for (const w of enCarpeta) if (!clave.includes(w) && atributos.has(w)) p += 3;
  return p;
}

// Asigna cada carpeta a un reloj distinto, empezando por las coincidencias más claras.
export function asignarCarpetas<T extends Record<string, string>>(relojes: T[], carpetas: CarpetaReloj[]) {
  const pares: { c: CarpetaReloj; r: T; p: number }[] = [];
  for (const c of carpetas) for (const r of relojes) { const p = puntaje(c.nombre, r); if (p > 0) pares.push({ c, r, p }); }
  pares.sort((a, b) => b.p - a.p);
  const asignado = new Map<T, CarpetaReloj>();
  const usadas = new Set<string>();
  for (const { c, r } of pares) {
    if (asignado.has(r) || usadas.has(c.id)) continue;
    asignado.set(r, c); usadas.add(c.id);
  }
  return asignado;
}
