import { db } from './db';
import { exportarPlanillaCsv } from './google';
import { carpetasRelojes, asignarCarpetas, CarpetaReloj } from './fotos';

// Solo estas columnas pueden llegar a un cliente. Costos, gastos, ganancias, ahorro e inversión quedan afuera a propósito.
const PUBLICAS: Record<string, string> = {
  marca: 'Marca', modelo: 'Modelo', referencia: 'Referencia', 'año': 'Año', ano: 'Año',
  movimiento: 'Movimiento', maquinaria: 'Calibre', caja: 'Caja original', papeles: 'Papeles',
  'tamaño': 'Tamaño', tamano: 'Tamaño', material: 'Material', 'condición': 'Condición', condicion: 'Condición',
  detalle: 'Detalle', fotos: 'Fotos', estado: 'Estado',
  'precio publicado': 'Precio', 'precio de lista': 'Precio', 'precio lista usd': 'Precio de lista',
  descuento: 'Descuento', 'precio final usd': 'Precio con descuento',
};

function parsearCsv(texto: string): string[][] {
  const filas: string[][] = []; let fila: string[] = []; let celda = ''; let comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { celda += '"'; i++; }
      else if (c === '"') comillas = false;
      else celda += c;
    } else if (c === '"') comillas = true;
    else if (c === ',') { fila.push(celda); celda = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(celda); filas.push(fila); fila = []; celda = '';
    } else celda += c;
  }
  if (celda || fila.length) { fila.push(celda); filas.push(fila); }
  return filas;
}

const norm = (s: string) => s.trim().toLowerCase();

function formatearDescuento(v: string) {
  const n = Number(v.replace('%', '').replace(',', '.'));
  if (!isFinite(n) || n <= 0) return '';
  return `${Math.round(n <= 1 ? n * 100 : n)}%`;
}

export type Reloj = Record<string, string>;

function leerPlanilla(csv: string, origen: string): Reloj[] {
  const filas = parsearCsv(csv).filter((f) => f.some((c) => c.trim()));
  const iEnc = filas.findIndex((f) => f.map(norm).includes('marca'));
  if (iEnc < 0) return [];
  const encabezado = filas[iEnc].map(norm);
  const iVenta = encabezado.indexOf('precio venta');
  const iEstado = encabezado.indexOf('estado');
  const relojes: Reloj[] = [];
  for (const f of filas.slice(iEnc + 1)) {
    const marca = (f[0] || '').trim();
    if (!marca || /^total$/i.test(marca)) continue;
    const vendido = (iVenta >= 0 && f[iVenta]?.trim()) || (iEstado >= 0 && /vendid|reservad/i.test(f[iEstado] || ''));
    if (vendido) continue;
    const r: Reloj = {};
    encabezado.forEach((h, i) => {
      const etiqueta = PUBLICAS[h];
      let v = f[i]?.trim();
      if (!etiqueta || !v) return;
      if (etiqueta === 'Descuento') { v = formatearDescuento(v); if (!v) return; }
      if (/precio/i.test(etiqueta) && /^\d+([.,]\d+)?$/.test(v)) v = `${Math.round(Number(v.replace(',', '.')) * 100) / 100} USD`;
      r[etiqueta] = v;
    });
    if (!r['Precio'] && !r['Precio de lista']) r['Precio'] = 'a consultar';
    r['Origen'] = origen;
    relojes.push(r);
  }
  return relojes;
}

let cache: { cuando: number; relojes: Reloj[] } | null = null;

export async function stockDisponible(): Promise<Reloj[]> {
  if (cache && Date.now() - cache.cuando < 5 * 60000) return cache.relojes;
  const { data } = await db().from('credenciales').select('clave, valor')
    .in('clave', ['stock_sheet_id', 'stock_pagina_sheet_id', 'notas_stock']);
  const valor = (k: string) => data?.find((d) => d.clave === k)?.valor;
  const relojes: Reloj[] = [];
  if (valor('stock_sheet_id')) relojes.push(...leerPlanilla(await exportarPlanillaCsv(valor('stock_sheet_id')!), 'colección'));
  if (valor('stock_pagina_sheet_id')) relojes.push(...leerPlanilla(await exportarPlanillaCsv(valor('stock_pagina_sheet_id')!), 'página'));
  // Notas manuales por referencia y precio (ej.: diferencias entre dos piezas iguales).
  try {
    for (const n of JSON.parse(valor('notas_stock') || '[]') as { referencia: string; precio: string; detalle: string }[]) {
      const r = relojes.find((x) => (x['Referencia'] || '') === n.referencia && (x['Precio'] || '').startsWith(n.precio));
      if (r) r['Detalle'] = r['Detalle'] ? `${r['Detalle']}. ${n.detalle}` : n.detalle;
    }
  } catch { /* notas mal formadas: se ignoran */ }
  // Margaret solo ofrece los relojes que tienen fotos o videos en "Fotos relojes".
  const asignado = asignarCarpetas(relojes, await carpetasRelojes().catch(() => []));
  const conFotos = relojes.filter((r) => asignado.has(r));
  for (const r of conFotos) {
    const c = asignado.get(r)!;
    r['Fotos'] = `${c.fotos.length} foto(s)${c.videos.length ? ` y ${c.videos.length} video(s)` : ''}`;
    carpetaDe.set(r, c);
  }
  cache = { cuando: Date.now(), relojes: conFotos };
  return conFotos;
}

const carpetaDe = new WeakMap<Reloj, CarpetaReloj>();
export const carpetaDelReloj = (r: Reloj) => carpetaDe.get(r);

export function stockComoTexto(relojes: Reloj[]) {
  if (!relojes.length) return 'No hay relojes en stock en este momento.';
  return relojes.map((r, i) => `${i + 1}. ${Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(' · ')}`).join('\n');
}
