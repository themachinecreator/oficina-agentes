import Anthropic from '@anthropic-ai/sdk';
import { db, setAhora } from './db';
import { anthropic, fechaBA, hoyISO } from './claude';
import { escribirRango, columnaLetra } from './google';
import { avisar, enviarFoto, dueñoChatId } from './telegram';
import {
  leerLibro, asegurarFechas, celda, costoTotal, vendido, nombreReloj, numero, usd, resumenFinanzas, Libro,
} from './henry';

// Henry como agente: recibe un pedido abierto de Beltrán (vía Arthur), lo trabaja con sus herramientas
// sobre la planilla Watches y le manda el informe directamente por Telegram.
const MODELO_HENRY = process.env.HENRY_MODEL || process.env.JULIAN_MODEL || 'claude-sonnet-5-5';

// Acepta 2026-10-28, 28/10/2026 o 28-10-26.
export function fecha(v: any): string | null {
  const s = String(v ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

function verLibro(l: Libro) {
  const lineas = l.filas.map((f) => {
    const datos = l.encabezado.map((h, i) => (h && String(f.v[i] ?? '').trim() ? `${h}: ${f.v[i]}` : '')).filter(Boolean).join(' | ');
    return `Fila ${f.n} (${vendido(f, l) ? 'vendido' : 'en stock'}): ${datos}`;
  });
  return `Columnas: ${l.encabezado.filter(Boolean).join(', ')}\n${lineas.join('\n')}`;
}

async function escribirCelda(input: { fila: number; columna: string; valor: string }) {
  let l = await leerLibro();
  const f = l.filas.find((x) => x.n === input.fila);
  if (!f) return `La fila ${input.fila} no es de un reloj que yo lleve (solo trabajo con los que tienen carpeta de fotos y con las ventas ya hechas).`;
  if (/fecha/i.test(input.columna)) l = await asegurarFechas(l);
  const objetivo = input.columna.trim().toLowerCase();
  const enc = (await leerLibro()).encabezado;
  let i = enc.findIndex((h) => h.toLowerCase() === objetivo);
  if (i < 0 && /fecha compra/i.test(objetivo)) i = l.col.fechaCompra;
  if (i < 0 && /fecha venta/i.test(objetivo)) i = l.col.fechaVenta;
  if (i === undefined || i < 0) return `No existe la columna "${input.columna}". Columnas: ${enc.filter(Boolean).join(', ')}`;
  const valor = /fecha/i.test(objetivo) ? fecha(input.valor) || input.valor : input.valor;
  await escribirRango(l.id, `'${l.hoja}'!${columnaLetra(i)}${input.fila}`, [[valor]]);
  return `Fila ${input.fila}, ${enc[i] || input.columna}: ${valor}`;
}

// Patrimonio = capital aportado + ganancia acumulada (ventas menos costo, menos gastos).
// El capital aportado es la inversión inicial de la planilla; si no está, lo que había invertido en relojes al principio.
async function graficoPatrimonial() {
  const l = await leerLibro();
  const { data: gastos } = await db().from('gastos').select('fecha, monto_usd');
  const items = l.filas.map((f) => ({
    nombre: nombreReloj(f, l), costo: costoTotal(f, l),
    compra: fecha(celda(f, l, 'fechaCompra')), venta: vendido(f, l) ? fecha(celda(f, l, 'fechaVenta')) : null,
    precio: numero(celda(f, l, 'venta')) ?? 0, lista: numero(celda(f, l, 'lista')) ?? 0, vendido: vendido(f, l),
  }));
  const sinCompra = items.filter((x) => !x.compra);
  const sinVenta = items.filter((x) => x.vendido && !x.venta);
  const fechas = items.flatMap((x) => [x.compra, x.venta]).filter(Boolean) as string[];
  if (!fechas.length) return 'No hay fechas de compra ni de venta en la planilla: sin fechas no se puede armar la evolución. Cargalas primero.';
  const inicio = fechas.sort()[0];
  const hoy = hoyISO();
  const puntos: string[] = [];
  for (let d = new Date(inicio + 'T12:00:00Z'); d.toISOString().slice(0, 10) < hoy; d = new Date(d.getTime() + 7 * 86400000)) puntos.push(d.toISOString().slice(0, 10));
  puntos.push(hoy);

  const capitalEn = (t: string) => items.filter((x) => x.compra && x.compra <= t && !(x.venta && x.venta <= t)).reduce((s, x) => s + x.costo, 0);
  const listaEn = (t: string) => items.filter((x) => x.compra && x.compra <= t && !(x.venta && x.venta <= t)).reduce((s, x) => s + (x.lista || x.costo), 0);
  const gananciaEn = (t: string) =>
    items.filter((x) => x.venta && x.venta <= t).reduce((s, x) => s + x.precio - x.costo, 0) -
    (gastos || []).filter((g) => String(g.fecha) <= t).reduce((s, g) => s + Number(g.monto_usd), 0);
  const inversion = l.filas.map((f) => numero(celda(f, l, 'inversion'))).find((n) => n !== null) ?? null;
  const aportado = inversion ?? capitalEn(inicio);

  const serie = puntos.map((t) => ({ t, capital: capitalEn(t), lista: listaEn(t), patrimonio: aportado + gananciaEn(t) }));
  const etiqueta = (t: string) => `${t.slice(8, 10)}/${t.slice(5, 7)}`;
  const chart = {
    type: 'line',
    data: {
      labels: serie.map((p) => etiqueta(p.t)),
      datasets: [
        { label: 'Patrimonio', data: serie.map((p) => Math.round(p.patrimonio)), borderColor: '#1f3d2b', backgroundColor: 'rgba(31,61,43,0.12)', fill: true, borderWidth: 3, pointRadius: 2 },
        { label: 'Relojes a costo', data: serie.map((p) => Math.round(p.capital)), borderColor: '#9a7b3c', borderWidth: 2, pointRadius: 2, fill: false },
        { label: 'Relojes a precio de lista', data: serie.map((p) => Math.round(p.lista)), borderColor: '#9a7b3c', borderDash: [6, 4], borderWidth: 2, pointRadius: 0, fill: false },
      ],
    },
    options: {
      plugins: { title: { display: true, text: 'beltranrelojes · evolución patrimonial (USD)', font: { size: 18 } }, legend: { position: 'bottom' } },
      scales: { y: { beginAtZero: false } },
    },
  };
  const r = await fetch('https://quickchart.io/chart', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chart, width: 900, height: 520, format: 'png', backgroundColor: 'white', version: '4' }),
  });
  if (!r.ok) return `No pude dibujar el gráfico (${r.status}).`;
  const ultimo = serie[serie.length - 1];
  const pie = `Patrimonio hoy: ${usd(ultimo.patrimonio)} · relojes a costo ${usd(ultimo.capital)} · a precio de lista ${usd(ultimo.lista)}`;
  await enviarFoto(Buffer.from(await r.arrayBuffer()), `Henry — ${pie}`);
  return [
    `Gráfico enviado a Beltrán. ${pie}.`,
    `Capital aportado usado: ${usd(aportado)} (${inversion !== null ? 'inversión inicial de la planilla' : 'lo invertido en relojes al primer día'}).`,
    sinCompra.length ? `Sin fecha de compra (no entran): ${sinCompra.map((x) => x.nombre).join('; ')}.` : '',
    sinVenta.length ? `Ventas sin fecha (no entran): ${sinVenta.map((x) => x.nombre).join('; ')}.` : '',
  ].filter(Boolean).join('\n');
}

const herramientas: Anthropic.Tool[] = [
  { name: 'ver_libro', description: 'Lee la planilla Watches completa (solo los relojes que llevás): cada fila con su número y todas sus columnas, incluidos costos.', input_schema: { type: 'object', properties: {} } },
  { name: 'ver_gastos', description: 'Lista los gastos del negocio anotados.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'escribir_celda',
    description: 'Escribe un valor en una celda de la planilla Watches. Las fechas van como AAAA-MM-DD. Si la columna "Fecha compra" o "Fecha venta" no existe, se crea.',
    input_schema: {
      type: 'object',
      properties: { fila: { type: 'number', description: 'Número de fila de ver_libro' }, columna: { type: 'string', description: 'Nombre exacto de la columna' }, valor: { type: 'string' } },
      required: ['fila', 'columna', 'valor'],
    },
  },
  { name: 'grafico_patrimonial', description: 'Dibuja la evolución patrimonial del negocio y se la manda a Beltrán por Telegram como imagen.', input_schema: { type: 'object', properties: {} } },
  { name: 'resumen_finanzas', description: 'Resumen del mes: ventas, ganancia, gastos, capital en stock, retorno y relojes estancados.', input_schema: { type: 'object', properties: { mes: { type: 'string', description: 'AAAA-MM' } } } },
];

async function ejecutar(nombre: string, input: any) {
  try {
    if (nombre === 'ver_libro') return verLibro(await leerLibro());
    if (nombre === 'ver_gastos') {
      const { data } = await db().from('gastos').select('fecha, concepto, monto_usd, categoria').order('fecha');
      return data?.length ? data.map((g) => `${g.fecha} · ${g.concepto} · ${usd(Number(g.monto_usd))} · ${g.categoria || ''}`).join('\n') : 'No hay gastos anotados.';
    }
    if (nombre === 'escribir_celda') return await escribirCelda(input);
    if (nombre === 'grafico_patrimonial') return await graficoPatrimonial();
    if (nombre === 'resumen_finanzas') return await resumenFinanzas(input?.mes);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
  return 'Herramienta desconocida.';
}

const SISTEMA = () => `Sos Henry Caldwell, el contador interno de beltranrelojes (compraventa de relojes de Beltrán Symonds). Prolijo, preciso y discreto; escribís en español rioplatense con voseo, formal y breve, en texto plano para Telegram (sin markdown, sin asteriscos, sin tablas).
Fecha en Buenos Aires: ${fechaBA()}.
Trabajás sobre la planilla Watches en dólares. Solo llevás los relojes que tienen carpeta de fotos en el Drive y las ventas ya hechas (historial). No hacés temas impositivos.
Reglas:
- Leé la planilla con ver_libro antes de tocar nada. Nunca inventes costos, precios ni fechas: escribí solo lo que Beltrán dijo o lo que ya consta en el pedido.
- Si un dato no alcanza para decidir (por ejemplo, qué reloj fue la venta sin fecha), no lo adivines: dejalo sin tocar y preguntáselo a Beltrán al final del informe.
- Las fechas se escriben AAAA-MM-DD.
- Cuando propongas mejoras, que sean concretas y basadas en los números de la planilla (rotación, margen, precios de lista, capital inmovilizado, gastos), no consejos genéricos.
- Terminá con un informe corto para Beltrán: qué hiciste, qué cambió en la planilla, lo que muestre el gráfico si lo mandaste, y lo que necesitás que te confirme.`;

export async function trabajarHenry(pedido: string, tareaId?: number) {
  await setAhora('henry', `Trabajando: ${pedido.slice(0, 80)}`, 'ok');
  if (tareaId) await db().from('tareas').update({ estado: 'en_curso', actualizada: new Date().toISOString() }).eq('id', tareaId);
  const mensajes: Anthropic.MessageParam[] = [{ role: 'user', content: `Pedido de Beltrán (te lo pasa Arthur): ${pedido}` }];
  try {
    for (let vuelta = 0; vuelta < 14; vuelta++) {
      const r = await anthropic.messages.create({ model: MODELO_HENRY, max_tokens: 2500, system: SISTEMA(), tools: herramientas, messages: mensajes });
      if (r.stop_reason !== 'tool_use') {
        const informe = r.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim() || 'Listo.';
        const texto = `Henry — ${informe}`;
        await avisar(texto);
        const chat = dueñoChatId();
        if (chat) await db().from('mensajes').insert({ chat_id: Number(chat), rol: 'assistant', contenido: texto });
        if (tareaId) await db().from('tareas').update({ estado: 'hecha', actualizada: new Date().toISOString() }).eq('id', tareaId);
        await setAhora('henry', 'Terminó un pedido y te mandó el informe.', 'ok');
        return informe;
      }
      mensajes.push({ role: 'assistant', content: r.content });
      const res: Anthropic.ToolResultBlockParam[] = [];
      for (const b of r.content) if (b.type === 'tool_use') res.push({ type: 'tool_result', tool_use_id: b.id, content: await ejecutar(b.name, b.input) });
      mensajes.push({ role: 'user', content: res });
    }
    throw new Error('el pedido le llevó demasiados pasos');
  } catch (e: any) {
    await setAhora('henry', 'No pudo terminar un pedido.', 'idle');
    if (tareaId) await db().from('tareas').update({ estado: 'pendiente', actualizada: new Date().toISOString() }).eq('id', tareaId);
    await avisar(`Henry no pudo terminar el pedido: ${e.message}`);
    throw e;
  }
}
