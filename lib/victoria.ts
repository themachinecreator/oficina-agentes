import Anthropic from '@anthropic-ai/sdk';
import { db, setAhora } from './db';
import { anthropic, fechaBA } from './claude';
import { avisar, enviarConBotones, dueñoChatId } from './telegram';
import { crearAprobacion } from './aprobaciones';
import { pedirIdeas, pedirGuion, listarGuiones } from './julian';
import { stockDisponible } from './stock';
import {
  resumenCuenta, cuentaAds, gastoDelMes, buscarSegmentacion, resultadosCampanas, pausarCampana, TOPE_MENSUAL_USD, Publico, graph,
} from './marketing';

// Victoria Ashford, marketing: mide la cuenta, dirige el contenido con Julian y Theo y propone anuncios con aprobación.
const MODELO = process.env.VICTORIA_MODEL || process.env.JULIAN_MODEL || 'claude-sonnet-5-5';

const herramientas: Anthropic.Tool[] = [
  { name: 'ver_cuenta', description: 'Seguidores (hoy, hace 7 y 30 días) y las últimas 20 publicaciones con likes, comentarios y, si hay permiso, vistas, alcance y guardados. Incluye el id de cada publicación.', input_schema: { type: 'object', properties: {} } },
  { name: 'ver_guiones', description: 'Guiones de Julian y en qué estado están (propuesto, grabado, editado, publicado).', input_schema: { type: 'object', properties: {} } },
  { name: 'ver_stock', description: 'Relojes en venta con fotos (para decidir qué anunciar).', input_schema: { type: 'object', properties: {} } },
  { name: 'ver_historias', description: 'Historias y reels que publicó Theo últimamente.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'encargar_ideas_a_julian',
    description: 'Le pide a Julian ideas de videos con un enfoque que vos definís a partir de los números. Julian se las manda a Beltrán por Telegram.',
    input_schema: { type: 'object', properties: { enfoque: { type: 'string' }, cantidad: { type: 'number' } }, required: ['enfoque'] },
  },
  {
    name: 'encargar_guion_a_julian',
    description: 'Le pide a Julian un guion concreto (tema y notas tuyas). Julian se lo manda a Beltrán para grabar; después Theo lo edita.',
    input_schema: { type: 'object', properties: { tema: { type: 'string' }, formato: { type: 'string' }, notas: { type: 'string' } }, required: ['tema'] },
  },
  { name: 'ver_campanas', description: 'Campañas de anuncios con su estado y resultados (gasto, alcance, conversaciones o visitas al perfil y costo por resultado) y cuánto queda del presupuesto del mes.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'buscar_segmentacion',
    description: 'Busca intereses o ubicaciones de Meta para armar el público de un anuncio.',
    input_schema: { type: 'object', properties: { tipo: { type: 'string', enum: ['interes', 'ubicacion'] }, q: { type: 'string' } }, required: ['tipo', 'q'] },
  },
  {
    name: 'proponer_campana',
    description: 'Propone a Beltrán un anuncio promocionando una publicación existente. No se gasta nada hasta que él aprueba por Telegram.',
    input_schema: {
      type: 'object',
      properties: {
        objetivo: { type: 'string', enum: ['mensajes', 'seguidores'], description: 'mensajes = conversaciones por privado (venta, atiende Margaret); seguidores = visitas al perfil' },
        media_id: { type: 'string', description: 'id de la publicación (de ver_cuenta)' },
        presupuesto_usd: { type: 'number' }, dias: { type: 'number' },
        publico: {
          type: 'object',
          properties: {
            edad_min: { type: 'number' }, edad_max: { type: 'number' }, genero: { type: 'string', enum: ['todos', 'hombres', 'mujeres'] },
            ciudades: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, nombre: { type: 'string' }, radio_km: { type: 'number' } }, required: ['key'] } },
            regiones: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, nombre: { type: 'string' } }, required: ['key'] } },
            intereses: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'] } },
          },
        },
        por_que: { type: 'string', description: 'Por qué esta publicación, este público y este monto, en dos o tres líneas.' },
      },
      required: ['objetivo', 'media_id', 'presupuesto_usd', 'dias', 'publico', 'por_que'],
    },
  },
  { name: 'pausar_campana', description: 'Pausa una campaña que no está funcionando.', input_schema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
];

// Meta no habilita la API de anuncios sin verificar el negocio: si no hay acceso, la campaña la lanza Beltrán
// desde la app de Instagram con las indicaciones exactas de Victoria (modo manual).
async function proponer(input: any) {
  const c = await cuentaAds().catch(() => null);
  const manual = !c;
  const g = manual ? null : await gastoDelMes().catch(() => null);
  const mes = new Date().toISOString().slice(0, 7);
  const { data: delMes } = await db().from('campanas').select('presupuesto_usd, estado, creado').in('estado', ['propuesta', 'activa', 'terminada', 'pausada']);
  const usadoManual = (delMes || []).filter((x) => String(x.creado).startsWith(mes) && x.estado !== 'propuesta').reduce((s, x) => s + Number(x.presupuesto_usd), 0);
  const enEspera = (delMes || []).filter((x) => x.estado === 'propuesta').reduce((s, x) => s + Number(x.presupuesto_usd), 0);
  const disponible = (g ? g.disponibleUsd : TOPE_MENSUAL_USD - usadoManual) - enEspera;
  if (input.presupuesto_usd > disponible + 0.01) return `No alcanza: quedan ${Math.max(0, disponible).toFixed(2)} USD del tope de ${TOPE_MENSUAL_USD} este mes (contando propuestas sin aprobar). Ajustá el monto.`;
  if (input.presupuesto_usd < 3 || input.dias < 2) return 'Muy chico: mínimo 3 USD y 2 días para que Meta aprenda algo.';
  const post = await graph(`${input.media_id}?fields=permalink,caption`).catch(() => null);
  if (!post) return 'No encontré esa publicación; usá un id de ver_cuenta.';
  const p: Publico & { ciudades?: any[]; regiones?: any[] } = input.publico || {};
  const donde = [...(p.ciudades || []).map((x: any) => `${x.nombre || x.key} (${x.radio_km || 25} km)`), ...(p.regiones || []).map((x: any) => x.nombre || x.key)].join(', ') || 'toda Argentina';
  const descripcion = `${String(post.caption || '').split('\n')[0].slice(0, 60)}`;
  const { data: fila } = await db().from('campanas').insert({
    objetivo: input.objetivo, media_id: input.media_id, descripcion, presupuesto_usd: input.presupuesto_usd, dias: input.dias, publico: p,
  }).select('id').single();
  const texto = [
    `Victoria — propuesta de anuncio #${fila?.id}`,
    `Objetivo: ${input.objetivo === 'mensajes' ? 'mensajes por privado (atiende Margaret)' : 'visitas al perfil y seguidores'}`,
    `Publicación: ${post.permalink}`,
    `Monto: ${input.presupuesto_usd} USD en ${input.dias} días (quedan ${disponible.toFixed(2)} de ${TOPE_MENSUAL_USD} este mes)`,
    `Público: ${p.edad_min || 25}-${p.edad_max || 60} años, ${p.genero && p.genero !== 'todos' ? p.genero : 'hombres y mujeres'}, ${donde}${p.intereses?.length ? `; intereses: ${p.intereses.map((i) => i.name).join(', ')}` : ''}`,
    '', input.por_que,
  ].join('\n');
  const pasos = manual ? [
    '', 'Cómo lanzarlo (2 minutos, desde la app de Instagram):',
    `1. Abrí la publicación: ${post.permalink} y tocá "Promocionar".`,
    `2. Objetivo: ${input.objetivo === 'mensajes' ? '"Más mensajes"' : '"Más visitas al perfil"'}.`,
    `3. Público: "Crear el tuyo" → ${donde}; edad ${p.edad_min || 25}-${p.edad_max || 60}; ${p.genero && p.genero !== 'todos' ? p.genero : 'todos los géneros'}${p.intereses?.length ? `; intereses: ${p.intereses.map((i) => i.name).join(', ')}` : ''}.`,
    `4. Presupuesto: ${(input.presupuesto_usd / input.dias).toFixed(2)} USD por día durante ${input.dias} días (total ${input.presupuesto_usd} USD).`,
    '5. Revisá y tocá "Promocionar publicación".',
  ].join('\n') : '';
  const textoFinal = texto + pasos;
  const id = await crearAprobacion('victoria', textoFinal, 'campana', { campanaId: fila?.id, manual });
  const msg = await enviarConBotones(textoFinal, manual
    ? [{ texto: 'Ya lo lancé', dato: `apr:${id}:si` }, { texto: 'No lo hago', dato: `apr:${id}:no` }]
    : [{ texto: 'Lanzar', dato: `apr:${id}:si` }, { texto: 'No', dato: `apr:${id}:no` }]);
  if (msg) await db().from('aprobaciones').update({ telegram_msg_id: msg }).eq('id', id);
  await setAhora('victoria', `Propuso el anuncio #${fila?.id}: espera tu aprobación.`, 'wait');
  return `Propuesta #${fila?.id} enviada a Beltrán para aprobar.`;
}

async function ejecutar(nombre: string, input: any) {
  try {
    const chat = dueñoChatId() || undefined;
    if (nombre === 'ver_cuenta') return await resumenCuenta();
    if (nombre === 'ver_guiones') return await listarGuiones();
    if (nombre === 'ver_stock') return (await stockDisponible()).map((r) => `${r['Marca']} ${r['Modelo']} ${r['Referencia'] ? 'ref. ' + r['Referencia'] : ''} · ${r['Precio con descuento'] || r['Precio'] || r['Precio de lista'] || ''}`).join('\n') || 'Sin stock con fotos.';
    if (nombre === 'ver_historias') {
      const { data } = await db().from('publicaciones').select('tipo, reloj, estado, creado').order('creado', { ascending: false }).limit(20);
      return (data || []).map((p) => `${String(p.creado).slice(0, 10)} · ${p.tipo} · ${p.reloj} · ${p.estado}`).join('\n') || 'Nada todavía.';
    }
    if (nombre === 'encargar_ideas_a_julian') { await pedirIdeas({ enfoque: `Pedido de Victoria (marketing): ${input.enfoque}`, cantidad: input.cantidad }, chat); return 'Julian mandó las ideas a Beltrán.'; }
    if (nombre === 'encargar_guion_a_julian') { const g = await pedirGuion({ tema: input.tema, formato: input.formato, notas: `Pedido de Victoria (marketing). ${input.notas || ''}` }, chat); return `Julian mandó el guion #${g.id}.`; }
    if (nombre === 'ver_campanas') {
      const g = await gastoDelMes().catch(() => null);
      return `${g ? `Este mes: gastado ${g.gastadoUsd.toFixed(2)} USD, comprometido ${g.comprometidoUsd.toFixed(2)}, disponible ${g.disponibleUsd.toFixed(2)} de ${TOPE_MENSUAL_USD}.` : 'Cuenta publicitaria sin conectar.'}\n${await resultadosCampanas()}`;
    }
    if (nombre === 'buscar_segmentacion') return await buscarSegmentacion(input.tipo, input.q);
    if (nombre === 'proponer_campana') return await proponer(input);
    if (nombre === 'pausar_campana') return await pausarCampana(input.id);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
  return 'Herramienta desconocida.';
}

const SISTEMA = () => `Sos Victoria Ashford, estratega de marketing de beltranrelojes: la cuenta de Instagram del negocio de compraventa de relojes vintage y de lujo de Beltrán Symonds en Buenos Aires (unos 3.200 seguidores). Analítica, directa y con criterio; escribís en español rioplatense con voseo, en texto plano para Telegram (sin markdown, sin asteriscos, sin tablas), corto y al grano.
Fecha en Buenos Aires: ${fechaBA()}.
Tu objetivo: que la cuenta crezca y que lleguen más compradores por privado (ahí contesta Margaret).
El equipo con el que trabajás: Julian Hart escribe ideas y guiones (Beltrán los graba), Theo Lang edita los reels y publica historias del stock cada dos días. Vos marcás la dirección con los números.
Presupuesto de anuncios: hasta ${TOPE_MENSUAL_USD} USD por mes, y cada campaña la aprueba Beltrán. Si la cuenta publicitaria no está conectada por API, proponer_campana igual funciona: Beltrán la lanza desde la app de Instagram con tus indicaciones exactas y te avisa con un botón. Repartilo entre ventas (anuncios de relojes del stock con objetivo mensajes) y crecimiento (los reels que mejor funcionan, objetivo seguidores). Preferí pocas campañas chicas para probar, de 3 a 7 días, y mirá el costo por resultado antes de volver a invertir.
Reglas:
- Basate en los datos de tus herramientas; nunca inventes cifras. Si falta un dato (por ejemplo estadísticas sin permiso), decilo.
- Para anunciar usá publicaciones existentes de la cuenta (ver_cuenta da los ids). Para ventas, solo relojes que estén en ver_stock.
- Público por defecto para relojes de lujo en Argentina: 25 a 60 años, CABA y GBA o ciudades grandes, intereses de relojería y lujo. Buscá las claves con buscar_segmentacion.
- Nunca reveles costos ni márgenes del negocio en textos públicos.
- Terminá con un informe corto para Beltrán: qué ves en los números, qué decidiste (ideas o guiones encargados, anuncios propuestos) y qué le recomendás grabar o hacer esta semana.`;

export async function trabajarVictoria(pedido: string) {
  await setAhora('victoria', `Trabajando: ${pedido.slice(0, 80)}`, 'ok');
  const mensajes: Anthropic.MessageParam[] = [{ role: 'user', content: pedido }];
  try {
    const sistemaFijo = SISTEMA();
    for (let vuelta = 0; vuelta < 16; vuelta++) {
      const r = await anthropic.messages.create({ model: MODELO, max_tokens: 2500, system: sistemaFijo, tools: herramientas, messages: mensajes });
      if (r.stop_reason !== 'tool_use') {
        const informe = r.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim().replace(/\*\*|^#+\s*/gm, '') || 'Listo.';
        const texto = `Victoria — ${informe}`;
        await avisar(texto);
        const chat = dueñoChatId();
        if (chat) await db().from('mensajes').insert({ chat_id: Number(chat), rol: 'assistant', contenido: texto });
        const { count } = await db().from('aprobaciones').select('id', { count: 'exact', head: true }).eq('agente', 'victoria').eq('estado', 'pendiente');
        await setAhora('victoria', count ? 'Tiene un anuncio esperando tu aprobación.' : 'Te mandó su informe.', count ? 'wait' : 'ok');
        return informe;
      }
      mensajes.push({ role: 'assistant', content: r.content });
      const res: Anthropic.ToolResultBlockParam[] = [];
      for (const b of r.content) if (b.type === 'tool_use') res.push({ type: 'tool_result', tool_use_id: b.id, content: await ejecutar(b.name, b.input) });
      mensajes.push({ role: 'user', content: res });
    }
    throw new Error('el pedido le llevó demasiados pasos');
  } catch (e: any) {
    await setAhora('victoria', 'No pudo terminar un pedido.', 'idle');
    await avisar(`Victoria no pudo terminar: ${e.message}`);
    throw e;
  }
}

export const PEDIDO_SEMANAL = 'Informe semanal de los lunes. Revisá cómo viene la cuenta (seguidores y qué publicaciones funcionaron mejor y peor), los guiones pendientes, lo que publicó Theo y las campañas. Decidí la dirección de la semana: encargale a Julian ideas o un guion concreto según lo que funciona, y si queda presupuesto y hay algo que valga la pena, proponé un anuncio. Después mandale el informe a Beltrán.';
