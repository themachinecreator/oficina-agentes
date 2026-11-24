import { db } from './db';
import { exportarPlanillaCsv } from './google';
import { carpetasRelojes, asignarCarpetas, CarpetaReloj, videosSocio, asignarArchivosSocio, carpetasPagina } from './fotos';

// Solo estas columnas pueden llegar a un cliente. Costos, gastos, ganancias, ahorro e inversión quedan afuera a propósito.
const PUBLICAS: Record<string, string> = {
  marca: 'Marca', modelo: 'Modelo', referencia: 'Referencia', 'año': 'Año', ano: 'Año',
  movimiento: 'Movimiento', maquinaria: 'Calibre', caja: 'Caja original', papeles: 'Papeles',
  'tamaño': 'Tamaño', tamano: 'Tamaño', material: 'Material', 'condición': 'Condición', condicion: 'Condición',
  detalle: 'Detalle', fotos: 'Fotos', estado: 'Estado', dial: 'Dial',
  'precio publicado': 'Precio', 'precio de lista': 'Precio', 'precio lista': 'Precio', 'precio lista usd': 'Precio de lista',
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
  const iFechaVenta = encabezado.indexOf('fecha venta');
  const relojes: Reloj[] = [];
  for (const f of filas.slice(iEnc + 1)) {
    const marca = (f[0] || '').trim();
    if (!marca || /^total$/i.test(marca)) continue;
    // Vendido: tiene precio de venta, o fecha de venta (aunque falte anotar el precio), o el estado lo dice.
    const vendido = (iVenta >= 0 && f[iVenta]?.trim()) || (iFechaVenta >= 0 && f[iFechaVenta]?.trim()) || (iEstado >= 0 && /vendid|reservad/i.test(f[iEstado] || ''));
    if (vendido) continue;
    const r: Reloj = {};
    encabezado.forEach((h, i) => {
      const etiqueta = PUBLICAS[h];
      let v = f[i]?.trim();
      if (!etiqueta || !v) return;
      if (etiqueta === 'Descuento') { v = formatearDescuento(v); if (!v) return; }
      if (/precio/i.test(etiqueta) && /^\d+([.,]\d+)?$/.test(v)) v = `US$ ${(Math.round(Number(v.replace(',', '.')) * 100) / 100).toLocaleString('es-AR')}`;
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
    .in('clave', ['stock_sheet_id', 'stock_pagina_sheet_id', 'notas_stock', 'socio_sheet_id', 'pagina_sheet_id']);
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
  // Relojes en sociedad (planilla y carpeta aparte): cada uno con su video.
  if (valor('socio_sheet_id')) {
    try {
      const socio = leerPlanilla(await exportarPlanillaCsv(valor('socio_sheet_id')!), 'sociedad');
      for (const r of socio) if (r['Dial'] && !r['Detalle']) r['Detalle'] = /bisel/i.test(r['Dial']) ? r['Dial'][0].toUpperCase() + r['Dial'].slice(1).toLowerCase() : `Dial ${r['Dial'].toLowerCase()}`;
      const archivosSocio = await videosSocio();
      const deSocio = asignarArchivosSocio(socio, archivosSocio);
      for (const r of socio) {
        const c = deSocio.get(r);
        if (!c) continue;
        r['Fotos'] = c.videos.length ? '1 video(s)' : '1 foto(s)';
        carpetaDe.set(r, c);
        conFotos.push(r);
      }
    } catch (e: any) {
      // Si la planilla del socio falla, sigue el resto del stock (queda anotado el motivo).
      await db().from('credenciales').upsert({ clave: 'socio_error', valor: String(e?.message || e), actualizado: new Date().toISOString() });
    }
  }
  // Catálogo de la página (planilla + una carpeta de fotos por reloj): suma solo los relojes que no están ya
  // (mismo reloj = misma marca y misma referencia, o mismo modelo y mismo dial).
  if (valor('pagina_sheet_id')) {
    try {
      const pegar = (x?: string) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
      const primera = (x?: string) => pegar(String(x || '').trim().split(/\s+/)[0]);
      const dialDe = (r: Reloj) => pegar(String(r['Dial'] || r['Detalle'] || '').replace(/^dial\s*/i, ''));
      const mismo = (a: Reloj, b: Reloj) => {
        if (pegar(a['Marca']) !== pegar(b['Marca'])) return false;
        const ra = pegar(a['Referencia']), rb = pegar(b['Referencia']);
        if (ra && rb) return ra === rb || ra.includes(rb) || rb.includes(ra);
        return primera(a['Modelo']) === primera(b['Modelo']) && !!dialDe(a) && dialDe(a) === dialDe(b);
      };
      const pagina = leerPlanilla(await exportarPlanillaCsv(valor('pagina_sheet_id')!), 'página');
      const carpetas = await carpetasPagina();
      for (const r of pagina) {
        if (r['Dial'] && !r['Detalle']) r['Detalle'] = `Dial ${r['Dial'].replace(/^dial\s*/i, '').toLowerCase()}`;
        if (conFotos.some((x) => mismo(x, r))) continue;
        // Carpeta del reloj: por referencia en el nombre; si no, por marca y modelo.
        const ref = pegar(r['Referencia']);
        const c = carpetas.find((k) => ref && pegar(k.nombre).includes(ref))
          || carpetas.find((k) => pegar(k.nombre).includes(pegar(r['Modelo'])) && pegar(k.nombre).includes(pegar(r['Marca']).slice(0, 4)));
        if (!c) continue;
        r['Fotos'] = `${c.fotos.length} foto(s) y ${c.videos.length} video(s)`;
        carpetaDe.set(r, c);
        conFotos.push(r);
      }
    } catch (e: any) {
      await db().from('credenciales').upsert({ clave: 'pagina_error', valor: String(e?.message || e), actualizado: new Date().toISOString() });
    }
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
