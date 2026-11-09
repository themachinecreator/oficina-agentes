import { db } from './db';
import { exportarPlanillaCsv } from './google';

// Solo estas columnas pueden llegar a un cliente. Costos, gastos y ganancias quedan afuera a propósito.
const PUBLICAS: Record<string, string> = {
  marca: 'Marca', modelo: 'Modelo', referencia: 'Referencia', 'año': 'Año', ano: 'Año',
  movimiento: 'Movimiento', maquinaria: 'Calibre', caja: 'Caja original', papeles: 'Papeles',
  'tamaño': 'Tamaño', tamano: 'Tamaño', material: 'Material', 'precio publicado': 'Precio', 'precio de lista': 'Precio', fotos: 'Fotos',
  estado: 'Estado',
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

export type Reloj = Record<string, string>;
let cache: { cuando: number; relojes: Reloj[] } | null = null;

export async function stockDisponible(): Promise<Reloj[]> {
  if (cache && Date.now() - cache.cuando < 5 * 60000) return cache.relojes;
  const { data } = await db().from('credenciales').select('valor').eq('clave', 'stock_sheet_id').maybeSingle();
  if (!data?.valor) throw new Error('Falta configurar la planilla de stock.');
  const filas = parsearCsv(await exportarPlanillaCsv(data.valor)).filter((f) => f.some((c) => c.trim()));
  const encabezado = filas[0].map(norm);
  const iVenta = encabezado.indexOf('precio venta');
  const iEstado = encabezado.indexOf('estado');
  const relojes: Reloj[] = [];
  for (const f of filas.slice(1)) {
    if (!f[0]?.trim() && !f[1]?.trim()) continue;
    const vendido = (iVenta >= 0 && f[iVenta]?.trim()) || (iEstado >= 0 && /vendid/i.test(f[iEstado] || ''));
    if (vendido) continue;
    const r: Reloj = {};
    encabezado.forEach((h, i) => {
      const etiqueta = PUBLICAS[h];
      if (etiqueta && f[i]?.trim()) r[etiqueta] = f[i].trim();
    });
    if (!r['Precio']) r['Precio'] = 'a consultar';
    relojes.push(r);
  }
  cache = { cuando: Date.now(), relojes };
  return relojes;
}

export function stockComoTexto(relojes: Reloj[]) {
  if (!relojes.length) return 'No hay relojes en stock en este momento.';
  return relojes.map((r, i) => `${i + 1}. ${Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(' · ')}`).join('\n');
}
