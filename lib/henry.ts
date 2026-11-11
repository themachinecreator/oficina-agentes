import { db, setAhora } from './db';
import { primeraHoja, leerRango, escribirRango, agregarFila, columnaLetra } from './google';
import { carpetasRelojes, asignarCarpetas } from './fotos';
import { db as _db } from './db';
import { hoyISO } from './claude';

// Henry trabaja sobre la planilla "Watches": es el libro de compras y ventas.
type Fila = { n: number; v: any[] }; // n = número de fila en la planilla (1 = encabezado)
export type Libro = { id: string; hoja: string; col: Record<string, number>; filas: Fila[]; encabezado: string[] };

const norm = (s: any) => String(s ?? '').trim().toLowerCase();
const COLUMNAS = {
  marca: ['marca'], modelo: ['modelo'], referencia: ['referencia'], anio: ['año', 'ano'],
  compra: ['precio compra'], gastos: ['gastos'], total: ['total'], venta: ['precio venta'],
  ganancia: ['ganancia'], lista: ['precio de lista', 'precio publicado'], inversion: ['inversion inicial', 'inversión inicial'],
  fechaCompra: ['fecha compra'], fechaVenta: ['fecha venta'], detalle: ['detalle'], movimiento: ['movimiento'],
};

export function numero(v: any): number | null {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace(/usd|us\$|\$/gi, '').trim();
  if (!s) return null;
  // "1.250,00" (formato argentino) o "1250.5"
  const limpio = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const n = Number(limpio);
  return isFinite(n) ? n : null;
}
export const usd = (n: number) => `${Math.round(n).toLocaleString('es-AR')} USD`;

async function notasStock(): Promise<{ referencia: string; precio: string; detalle: string }[]> {
  const { data } = await _db().from('credenciales').select('valor').eq('clave', 'notas_stock').maybeSingle();
  try { return JSON.parse(data?.valor || '[]'); } catch { return []; }
}

async function libroId() {
  const { data } = await db().from('credenciales').select('valor').eq('clave', 'stock_sheet_id').maybeSingle();
  if (!data?.valor) throw new Error('Falta la planilla Watches.');
  return data.valor;
}

export async function leerLibro(): Promise<Libro> {
  const id = await libroId();
  const hoja = await primeraHoja(id);
  const valores = await leerRango(id, `'${hoja}'`);
  const encabezado = (valores[0] || []).map(norm);
  const col: Record<string, number> = {};
  for (const [k, nombres] of Object.entries(COLUMNAS)) {
    const i = encabezado.findIndex((h) => nombres.includes(h));
    if (i >= 0) col[k] = i;
  }
  let filas = valores.slice(1).map((v, i) => ({ n: i + 2, v })).filter((f) => f.v.some((c) => String(c ?? '').trim()));
  // Henry trabaja solo con los relojes que tienen carpeta en "Fotos relojes"; las ventas ya hechas quedan como historial.
  const notas = await notasStock();
  const comoReloj = (f: Fila) => {
    const r: Record<string, string> = {};
    const etiquetas: Record<string, string> = { marca: 'Marca', modelo: 'Modelo', referencia: 'Referencia', detalle: 'Detalle', movimiento: 'Movimiento' };
    for (const [k, e] of Object.entries(etiquetas)) if (col[k] !== undefined && f.v[col[k]] !== undefined) r[e] = String(f.v[col[k]]);
    const lista = col.lista !== undefined ? String(f.v[col.lista] ?? '') : '';
    for (const n of notas) if (r['Referencia'] === n.referencia && lista.startsWith(n.precio)) r['Detalle'] = r['Detalle'] ? `${r['Detalle']}. ${n.detalle}` : n.detalle;
    return r;
  };
  const enStock = filas.filter((f) => col.venta === undefined || numero(f.v[col.venta]) === null);
  const relojes = enStock.map(comoReloj);
  const asignado = asignarCarpetas(relojes, await carpetasRelojes().catch(() => []));
  const conCarpeta = new Set(enStock.filter((_, i) => asignado.has(relojes[i])).map((f) => f.n));
  filas = filas.filter((f) => !enStock.includes(f) || conCarpeta.has(f.n));
  return { id, hoja, col, filas, encabezado: (valores[0] || []).map((h: any) => String(h ?? '').trim()) };
}

// Agrega al final las columnas de fecha si todavía no existen.
export async function asegurarFechas(l: Libro) {
  const faltan = (['fechaCompra', 'fechaVenta'] as const).filter((k) => l.col[k] === undefined);
  if (!faltan.length) return l;
  const encabezado = (await leerRango(l.id, `'${l.hoja}'!1:1`))[0] || [];
  let i = encabezado.length;
  for (const k of faltan) {
    await escribirRango(l.id, `'${l.hoja}'!${columnaLetra(i)}1`, [[k === 'fechaCompra' ? 'Fecha compra' : 'Fecha venta']]);
    l.col[k] = i++;
  }
  return l;
}

export const celda = (f: Fila, l: Libro, k: string) => (l.col[k] === undefined ? undefined : f.v[l.col[k]]);
export const costoTotal = (f: Fila, l: Libro) => numero(celda(f, l, 'total')) ?? ((numero(celda(f, l, 'compra')) ?? 0) + (numero(celda(f, l, 'gastos')) ?? 0));
export const vendido = (f: Fila, l: Libro) => numero(celda(f, l, 'venta')) !== null;
export const nombreReloj = (f: Fila, l: Libro) =>
  [celda(f, l, 'marca'), celda(f, l, 'modelo'), celda(f, l, 'referencia') && `ref. ${celda(f, l, 'referencia')}`, celda(f, l, 'detalle')]
    .filter(Boolean).join(' ');

function buscar(l: Libro, texto: string, soloStock: boolean) {
  const palabras = norm(texto).split(/\s+/).filter((p) => p.length > 1);
  return l.filas.filter((f) => {
    if (soloStock && vendido(f, l)) return false;
    const t = norm([celda(f, l, 'marca'), celda(f, l, 'modelo'), celda(f, l, 'referencia'), celda(f, l, 'detalle'), celda(f, l, 'lista')].join(' '));
    return palabras.every((p) => t.includes(p));
  });
}

function fechaValida(f?: string) { return f && /^\d{4}-\d{2}-\d{2}$/.test(f) ? f : hoyISO(); }

export async function registrarVenta(input: { reloj: string; precio: number; fecha?: string; costo_de_lista?: number }) {
  let l = await leerLibro();
  let candidatos = buscar(l, input.reloj, true);
  // Dos piezas iguales: se puede desempatar por precio de lista.
  if (candidatos.length > 1 && input.costo_de_lista) {
    const porLista = candidatos.filter((f) => numero(celda(f, l, 'lista')) === input.costo_de_lista);
    if (porLista.length === 1) candidatos = porLista;
  }
  if (!candidatos.length) return `No encontré en stock un reloj que coincida con "${input.reloj}".`;
  if (candidatos.length > 1) {
    return `Hay ${candidatos.length} relojes que coinciden. Preguntale a Beltrán cuál:\n` +
      candidatos.map((f) => `- ${nombreReloj(f, l)} (lista ${celda(f, l, 'lista') || 's/d'})`).join('\n');
  }
  l = await asegurarFechas(l);
  const f = candidatos[0];
  const costo = costoTotal(f, l);
  const ganancia = input.precio - costo;
  const fecha = fechaValida(input.fecha);
  const escribir = async (k: string, valor: any) => {
    if (l.col[k] === undefined) return;
    await escribirRango(l.id, `'${l.hoja}'!${columnaLetra(l.col[k])}${f.n}`, [[valor]]);
  };
  await escribir('venta', input.precio);
  // Si la ganancia es una fórmula de la planilla, la respetamos.
  if (l.col.ganancia !== undefined) {
    const formula = (await leerRango(l.id, `'${l.hoja}'!${columnaLetra(l.col.ganancia)}${f.n}`, 'FORMULA'))[0]?.[0];
    if (!String(formula ?? '').startsWith('=')) await escribir('ganancia', ganancia);
  }
  await escribir('fechaVenta', fecha);
  await setAhora('henry', `Registró la venta: ${nombreReloj(f, l)}.`, 'ok');
  const margen = costo ? Math.round((ganancia / costo) * 100) : null;
  return `Venta registrada: ${nombreReloj(f, l)} a ${usd(input.precio)} el ${fecha}. Costo ${usd(costo)}, ganancia ${usd(ganancia)}${margen !== null ? ` (${margen}% sobre el costo)` : ''}.`;
}

export async function registrarCompra(input: {
  marca: string; modelo: string; referencia?: string; anio?: string; precio_compra: number; gastos?: number;
  precio_lista?: number; detalle?: string; fecha?: string;
}) {
  const l = await asegurarFechas(await leerLibro());
  const ancho = Math.max(...Object.values(l.col)) + 1;
  const fila: any[] = Array(ancho).fill('');
  const poner = (k: string, v: any) => { if (l.col[k] !== undefined && v !== undefined && v !== null && v !== '') fila[l.col[k]] = v; };
  const gastos = input.gastos ?? 0;
  poner('marca', input.marca); poner('modelo', input.modelo); poner('referencia', input.referencia); poner('anio', input.anio);
  poner('compra', input.precio_compra); poner('gastos', gastos); poner('total', input.precio_compra + gastos);
  poner('lista', input.precio_lista ? `${input.precio_lista} USD` : ''); poner('detalle', input.detalle);
  poner('fechaCompra', fechaValida(input.fecha));
  await agregarFila(l.id, l.hoja, fila);
  await setAhora('henry', `Anotó la compra de un ${input.marca} ${input.modelo}.`, 'ok');
  // Recordatorio: sin carpeta de fotos, el reloj no entra en el stock de Margaret ni en los números de Henry.
  return `Compra registrada: ${input.marca} ${input.modelo}${input.referencia ? ` ref. ${input.referencia}` : ''}, costo total ${usd(input.precio_compra + gastos)}.` +
    (input.precio_lista ? '' : ' Falta el precio de lista: hasta que lo cargues, Margaret lo ofrece "a consultar".') +
    ' Completá en la planilla los datos técnicos (movimiento, tamaño, material) y creá su carpeta con fotos en "Fotos relojes": hasta entonces no entra en el stock de Margaret ni en los números de Henry.';
}

export async function registrarGasto(input: { concepto: string; monto: number; fecha?: string; categoria?: string }) {
  const { error } = await db().from('gastos').insert({
    concepto: input.concepto, monto_usd: input.monto, fecha: fechaValida(input.fecha), categoria: input.categoria || 'otros',
  });
  if (error) return `No pude anotar el gasto: ${error.message}`;
  await setAhora('henry', `Anotó un gasto: ${input.concepto}.`, 'ok');
  return `Gasto anotado: ${input.concepto}, ${usd(input.monto)}.`;
}

export async function analizarOferta(reloj: string, oferta: number) {
  const l = await leerLibro();
  const c = buscar(l, reloj, true);
  if (c.length !== 1) return null; // ambiguo o no está en la planilla con costos
  const f = c[0];
  const costo = costoTotal(f, l);
  if (!costo) return null;
  const lista = numero(celda(f, l, 'lista'));
  const g = oferta - costo;
  return `Henry: a ${usd(oferta)} ganarías ${usd(g)} (${Math.round((g / costo) * 100)}% sobre el costo de ${usd(costo)})` +
    (lista ? `. A precio de lista ganarías ${usd(lista - costo)}.` : '.') + (g < 0 ? ' Ojo: es por debajo del costo.' : '');
}

export async function resumenFinanzas(mes?: string) {
  const periodo = mes && /^\d{4}-\d{2}$/.test(mes) ? mes : hoyISO().slice(0, 7);
  const l = await leerLibro();
  const vendidos = l.filas.filter((f) => vendido(f, l));
  const enStock = l.filas.filter((f) => !vendido(f, l));
  const delMes = vendidos.filter((f) => String(celda(f, l, 'fechaVenta') ?? '').startsWith(periodo));
  const sinFecha = vendidos.filter((f) => !celda(f, l, 'fechaVenta'));
  const ingresosMes = delMes.reduce((a, f) => a + (numero(celda(f, l, 'venta')) ?? 0), 0);
  const gananciaMes = delMes.reduce((a, f) => a + ((numero(celda(f, l, 'venta')) ?? 0) - costoTotal(f, l)), 0);
  const gananciaTotal = vendidos.reduce((a, f) => a + ((numero(celda(f, l, 'venta')) ?? 0) - costoTotal(f, l)), 0);
  const capital = enStock.reduce((a, f) => a + costoTotal(f, l), 0);
  const valorLista = enStock.reduce((a, f) => a + (numero(celda(f, l, 'lista')) ?? 0), 0);
  const inversion = l.filas.map((f) => numero(celda(f, l, 'inversion'))).find((n) => n !== null) ?? null;

  const desde = `${periodo}-01`;
  const [a, m] = periodo.split('-').map(Number);
  const hasta = new Date(Date.UTC(a, m, 1)).toISOString().slice(0, 10);
  const { data: gastos } = await db().from('gastos').select('concepto, monto_usd').gte('fecha', desde).lt('fecha', hasta);
  const totalGastos = (gastos || []).reduce((s, g) => s + Number(g.monto_usd), 0);

  const hoy = Date.parse(hoyISO());
  const estancados = enStock
    .map((f) => ({ f, dias: celda(f, l, 'fechaCompra') ? Math.round((hoy - Date.parse(String(celda(f, l, 'fechaCompra')))) / 86400000) : null }))
    .filter((x) => x.dias !== null && x.dias >= 60)
    .sort((x, y) => (y.dias as number) - (x.dias as number));

  const lineas = [
    `Resumen ${periodo}`,
    `Ventas del mes: ${delMes.length} · ingresos ${usd(ingresosMes)} · ganancia bruta ${usd(gananciaMes)}`,
    `Gastos del mes: ${usd(totalGastos)}${gastos?.length ? ` (${gastos.map((g) => `${g.concepto} ${usd(Number(g.monto_usd))}`).join(', ')})` : ''}`,
    `Ganancia neta del mes: ${usd(gananciaMes - totalGastos)}`,
    `Stock: ${enStock.length} relojes · capital invertido ${usd(capital)} · valor a precio de lista ${usd(valorLista)}`,
    `Ganancia acumulada de todas las ventas: ${usd(gananciaTotal)}` +
      (inversion ? ` · retorno sobre la inversión inicial de ${usd(inversion)}: ${Math.round((gananciaTotal / inversion) * 100)}%` : ''),
  ];
  if (estancados.length) lineas.push(`Hace 60 días o más en stock: ${estancados.map((x) => `${nombreReloj(x.f, l)} (${x.dias} días)`).join(', ')}`);
  if (sinFecha.length) lineas.push(`${sinFecha.length} venta(s) sin fecha de venta en la planilla: no entran en los totales mensuales.`);
  const sinFechaCompra = enStock.filter((f) => !celda(f, l, 'fechaCompra')).length;
  if (sinFechaCompra) lineas.push(`${sinFechaCompra} reloj(es) en stock sin fecha de compra: cargala para medir cuánto tardan en venderse.`);
  await setAhora('henry', `Armó el resumen de ${periodo}.`, 'ok');
  return lineas.join('\n');
}
