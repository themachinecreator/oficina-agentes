import Anthropic from '@anthropic-ai/sdk';
import { db, setAhora, AgenteId } from './db';
import { anthropic, MODELO, fechaBA, PERFIL_BELTRAN } from './claude';
import { registrarVenta, registrarCompra, registrarGasto, resumenFinanzas } from './henry';
import { pedirGuion, pedirIdeas, revisarGuion, marcarGuion, listarGuiones } from './julian';
import { googleConectado, eventos, crearEvento, superposiciones, buscarCorreos, buscarEnDrive, leerDocumento, horaBA } from './google';

const EQUIPO = `
- eleanor (Eleanor Vance), secretaria personal: mail institucional, Google Calendar y Drive. Coordina las visitas con Margaret.
- margaret (Margaret Ellsworth), recepcionista de beltranrelojes: responde mensajes directos de Instagram con info y precio publicado. Las ofertas distintas al precio se derivan a Beltrán. Las visitas se confirman con aprobación de Beltrán.
- julian (Julian Hart), creador de contenido: ideas y guiones de videos cortos informativos, textos e historias.
- theo (Theo Lang), editor de video: edita lo que graba Beltrán, se lo muestra antes de publicar, sube historias de stock cada dos días.
- henry (Henry Caldwell), contador interno: registra compras, ventas y gastos en dólares en la planilla Watches y arma los resúmenes. No hace temas impositivos.`;

function sistema(conGoogle: boolean) {
  return `Sos Arthur Whitmore, jefe de la oficina de agentes de IA de Beltrán. La oficina trabaja para su negocio de relojes y como secretaría personal.
${PERFIL_BELTRAN}
Personalidad: sereno, metódico, formal y cordial. Hablás poco y decidís rápido. Escribís en español rioplatense, con voseo, en mensajes cortos aptos para Telegram (sin markdown, sin tablas, sin asteriscos).
Fecha y hora en Buenos Aires: ${fechaBA()}.

Tu trabajo: recibir los pedidos de Beltrán, repartirlos al agente correcto, contarle qué hay pendiente y mantener el orden.
Equipo:${EQUIPO}

Estado de los agentes:
- Vos estás conectado.
${conGoogle
    ? '- Eleanor está conectada: con sus herramientas (ver_agenda, crear_evento, buscar_mails, buscar_en_drive, leer_documento) resolvés vos mismo, en su nombre, lo que tenga que ver con agenda, mails y Drive. Decí "Eleanor" cuando corresponda. Ella además revisa el mail sola cada 10 minutos y le avisa a Beltrán.'
    : '- Eleanor todavía no tiene acceso a Google: sus pedidos quedan como tareas en cola.'}
${conGoogle ? '- Henry está conectado: cuando Beltrán cuente una venta, una compra o un gasto, o pregunte cómo viene el negocio, usá registrar_venta, registrar_compra, registrar_gasto o resumen_finanzas en su nombre. Cualquier otro pedido para Henry (corregir o completar datos de la planilla como fechas, gráficos, análisis, ideas de mejora) pasáselo con encargar_a_henry, nunca con crear_tarea: él lo hace solo y le manda el informe a Beltrán por Telegram, así que no hace falta que vos avises cuando termina. Si hay tareas de Henry en cola, también se las podés pasar con encargar_a_henry indicando el número. Todo en USD. Si el resultado dice que hay varios relojes posibles, preguntale a Beltrán cuál antes de reintentar. Nunca inventes costos ni precios.' : ''}
- Julian está conectado: cuando Beltrán pida un guion, ideas, cambios a un guion o el estado de los guiones, usá pedir_guion, pedir_ideas, revisar_guion, marcar_guion o ver_guiones. Julian le manda el guion directamente por Telegram: vos no lo repitas ni lo resumas, solo confirmá en una línea (por ejemplo "Te lo mandó Julian, es el #4"). Si Beltrán pide cambios sin decir el número, usá el último guion de la conversación.
- Theo está conectado: cuando Beltrán diga que subió las tomas de un guion (carpeta "Videos para editar/Guion N" en el Drive), usá editar_reel. Si no dijo si quiere música libre de derechos (Theo la pone y publica cuando Beltrán aprueba) o sin música (para que él ponga un audio de tendencia y publique), preguntale antes. Theo avisa por Telegram cuando el reel está listo. Las historias del stock se publican solas cada dos días a las 18; si Beltrán pide subirlas ya, usá publicar_historias (una por cada reloj con fotos, y Theo avisa al terminar).

Reglas:
- Todos los agentes están conectados: hacé los pedidos con sus herramientas, no con crear_tarea. crear_tarea es solo para dejar anotado un pendiente que Beltrán quiere recordar y que ninguna herramienta resuelve.
- No inventes resultados, datos de mercado, mails ni turnos. Si no sabés algo, decilo.
- Si un pedido es ambiguo, hacé una sola pregunta corta antes de actuar.
- Las fechas y horas que usás en las herramientas son de Buenos Aires, en formato AAAA-MM-DDTHH:MM.
- Antes de agendar, crear_evento ya revisa superposiciones. Si hay choque, contale a Beltrán y proponé otro horario; solo forzá si él lo pide.
- Confirmá en una línea cada cosa que hacés.`;
}

const AGENTES_COLA = ['eleanor', 'margaret', 'julian', 'theo', 'henry'];

const herramientasBase: Anthropic.Tool[] = [
  {
    name: 'crear_tarea',
    description: 'Crea una tarea en la cola de un agente. Usala para lo que le corresponde a un agente que todavía no está conectado, o para dejar un pendiente registrado.',
    input_schema: {
      type: 'object',
      properties: {
        agente: { type: 'string', enum: AGENTES_COLA },
        descripcion: { type: 'string', description: 'Qué tiene que hacer, en una o dos oraciones claras.' },
      },
      required: ['agente', 'descripcion'],
    },
  },
  {
    name: 'ver_tareas',
    description: 'Lista las tareas pendientes o en curso, de un agente o de toda la oficina.',
    input_schema: { type: 'object', properties: { agente: { type: 'string', enum: AGENTES_COLA } } },
  },
  {
    name: 'cerrar_tarea',
    description: 'Marca una tarea como hecha o cancelada cuando Beltrán lo indica.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'number' }, estado: { type: 'string', enum: ['hecha', 'cancelada'] } },
      required: ['id', 'estado'],
    },
  },
];

const herramientasGoogle: Anthropic.Tool[] = [
  {
    name: 'ver_agenda',
    description: 'Lista los eventos del Google Calendar de Beltrán entre dos fechas (inclusive).',
    input_schema: {
      type: 'object',
      properties: { desde: { type: 'string', description: 'AAAA-MM-DD' }, hasta: { type: 'string', description: 'AAAA-MM-DD' } },
      required: ['desde', 'hasta'],
    },
  },
  {
    name: 'crear_evento',
    description: 'Crea un evento en el Google Calendar de Beltrán. Revisa superposiciones y, si es una visita para ver relojes, aplica sus reglas de horario.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string' },
        inicio: { type: 'string', description: 'AAAA-MM-DDTHH:MM, o AAAA-MM-DD si es de todo el día' },
        fin: { type: 'string', description: 'AAAA-MM-DDTHH:MM. Si falta, dura una hora.' },
        todo_el_dia: { type: 'boolean' },
        lugar: { type: 'string' },
        descripcion: { type: 'string' },
        es_visita: { type: 'boolean', description: 'true si es una visita de un cliente para ver relojes' },
        forzar: { type: 'boolean', description: 'true solo si Beltrán pidió agendar igual aunque se superponga' },
      },
      required: ['titulo', 'inicio'],
    },
  },
  {
    name: 'buscar_mails',
    description: 'Busca mails en la casilla de Beltrán con la sintaxis de búsqueda de Gmail (por ejemplo "from:profesor@udesa.edu.ar newer_than:7d").',
    input_schema: { type: 'object', properties: { consulta: { type: 'string' } }, required: ['consulta'] },
  },
  {
    name: 'buscar_en_drive',
    description: 'Busca archivos en el Google Drive de Beltrán por texto.',
    input_schema: { type: 'object', properties: { consulta: { type: 'string' } }, required: ['consulta'] },
  },
  {
    name: 'leer_documento',
    description: 'Lee el texto de un documento o planilla de Drive por su id (sale de buscar_en_drive).',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

const herramientasHenry: Anthropic.Tool[] = [
  {
    name: 'registrar_venta',
    description: 'Registra la venta de un reloj de la planilla Watches: precio de venta, ganancia y fecha.',
    input_schema: {
      type: 'object',
      properties: {
        reloj: { type: 'string', description: 'Marca, modelo y/o referencia, más algún detalle si hay piezas iguales (ej. "Tudor 7996 dial blanco")' },
        precio: { type: 'number', description: 'Precio de venta en USD' },
        costo_de_lista: { type: 'number', description: 'Precio de lista en USD, si sirve para distinguir dos piezas iguales' },
        fecha: { type: 'string', description: 'AAAA-MM-DD; si falta, hoy' },
      },
      required: ['reloj', 'precio'],
    },
  },
  {
    name: 'registrar_compra',
    description: 'Agrega un reloj comprado a la planilla Watches con su costo.',
    input_schema: {
      type: 'object',
      properties: {
        marca: { type: 'string' }, modelo: { type: 'string' }, referencia: { type: 'string' }, anio: { type: 'string' },
        precio_compra: { type: 'number', description: 'USD' }, gastos: { type: 'number', description: 'Service, envío, etc. en USD' },
        precio_lista: { type: 'number', description: 'Precio al que lo va a publicar, en USD' },
        detalle: { type: 'string', description: 'Lo que lo distingue: dial, malla, estado' },
        fecha: { type: 'string', description: 'AAAA-MM-DD; si falta, hoy' },
      },
      required: ['marca', 'modelo', 'precio_compra'],
    },
  },
  {
    name: 'registrar_gasto',
    description: 'Anota un gasto del negocio en USD (oficina, suscripciones, envíos, publicidad, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        concepto: { type: 'string' }, monto: { type: 'number' },
        categoria: { type: 'string', enum: ['oficina', 'suscripciones', 'envios', 'publicidad', 'service', 'otros'] },
        fecha: { type: 'string', description: 'AAAA-MM-DD; si falta, hoy' },
      },
      required: ['concepto', 'monto'],
    },
  },
  {
    name: 'encargar_a_henry',
    description: 'Le pasa a Henry un pedido abierto (corregir o completar la planilla Watches, gráfico patrimonial, análisis, ideas de mejora). Henry trabaja en segundo plano y le manda el informe a Beltrán por Telegram.',
    input_schema: {
      type: 'object',
      properties: {
        pedido: { type: 'string', description: 'El pedido completo de Beltrán, con todos los datos que dio (fechas, montos, relojes).' },
        tarea_id: { type: 'number', description: 'Si retoma una tarea de la cola, su número.' },
      },
      required: ['pedido'],
    },
  },
  {
    name: 'resumen_finanzas',
    description: 'Resumen del mes: ventas, ganancia, gastos, capital en stock, retorno y relojes estancados.',
    input_schema: { type: 'object', properties: { mes: { type: 'string', description: 'AAAA-MM; si falta, el mes actual' } } },
  },
];

const herramientasJulian: Anthropic.Tool[] = [
  {
    name: 'pedir_guion',
    description: 'Julian escribe un guion completo de video corto (gancho, tomas, qué grabar, indicaciones para Theo, texto y hashtags) y se lo manda a Beltrán por Telegram.',
    input_schema: {
      type: 'object',
      properties: {
        tema: { type: 'string', description: 'Tema o reloj, si Beltrán lo dio. Si no, Julian elige.' },
        formato: { type: 'string', description: 'Ej.: historia, dato curioso, comparación, mito, detrás de escena' },
        notas: { type: 'string', description: 'Cualquier indicación extra de Beltrán (duración, estilo, reloj a mostrar)' },
      },
    },
  },
  {
    name: 'pedir_ideas',
    description: 'Julian, como director creativo, propone ideas de videos y un orden para la semana. Se las manda a Beltrán por Telegram.',
    input_schema: { type: 'object', properties: { cantidad: { type: 'number' }, enfoque: { type: 'string' } } },
  },
  {
    name: 'revisar_guion',
    description: 'Julian corrige un guion según lo que pida Beltrán y le manda la versión nueva.',
    input_schema: { type: 'object', properties: { id: { type: 'number' }, cambios: { type: 'string' } }, required: ['id', 'cambios'] },
  },
  {
    name: 'marcar_guion',
    description: 'Cambia el estado de un guion (grabado, editado, publicado, descartado).',
    input_schema: { type: 'object', properties: { id: { type: 'number' }, estado: { type: 'string', enum: ['grabado', 'editado', 'publicado', 'descartado'] } }, required: ['id', 'estado'] },
  },
  { name: 'ver_guiones', description: 'Lista los guiones pendientes con su estado.', input_schema: { type: 'object', properties: {} } },
];

const herramientasTheo: Anthropic.Tool[] = [
  {
    name: 'editar_reel',
    description: 'Theo edita el reel de un guion con las tomas que Beltrán subió a "Videos para editar/Guion N": recorta silencios, ordena, pone subtítulos del guion, logo y música opcional. Tarda un par de minutos y avisa por Telegram.',
    input_schema: {
      type: 'object',
      properties: {
        guion_id: { type: 'number' },
        musica: { type: 'string', enum: ['libre', 'sin'], description: 'libre = música libre de derechos y Theo publica al aprobar; sin = sin música para que Beltrán ponga un audio de tendencia' },
        subtitulos: { type: 'boolean', description: 'true por defecto' },
      },
      required: ['guion_id', 'musica'],
    },
  },
  { name: 'publicar_historias', description: 'Theo arma y publica ahora en Instagram una historia por cada reloj del stock con fotos o videos (con música y ficha de precio). Avisa por Telegram al terminar.', input_schema: { type: 'object', properties: {} } },
];

let chatActual: number | null = null;

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function reglaVisita(inicio: string, fin: string): string | null {
  const a = horaBA(inicio), b = horaBA(fin);
  const local = (d: Date) => new Date(d.getTime() - 3 * 3600000); // hora de Buenos Aires
  const la = local(a), lb = local(b);
  const dia = la.getUTCDay();
  const minIni = la.getUTCHours() * 60 + la.getUTCMinutes();
  const minFin = lb.getUTCHours() * 60 + lb.getUTCMinutes() + (lb.getUTCDate() !== la.getUTCDate() ? 1440 : 0);
  if (minFin > 18 * 60) return 'Las visitas no pueden terminar después de las 18.';
  if ((dia === 2 || dia === 4) && minIni < 15 * 60) return `Los ${DIAS[dia]} las visitas son desde las 15.`;
  return null;
}

async function ejecutar(nombre: string, input: any): Promise<string> {
  const base = db();
  try {
    if (nombre === 'crear_tarea') {
      const { data, error } = await base.from('tareas')
        .insert({ agente: input.agente, descripcion: input.descripcion, origen: 'arthur' }).select('id').single();
      if (error) return `Error al crear la tarea: ${error.message}`;
      await setAhora(input.agente as AgenteId, `Tarea en cola: ${input.descripcion}`);
      return `Tarea #${data.id} creada para ${input.agente}.`;
    }
    if (nombre === 'ver_tareas') {
      let q = base.from('tareas').select('id, agente, descripcion, estado, creada')
        .in('estado', ['pendiente', 'en_curso']).order('creada', { ascending: false }).limit(25);
      if (input?.agente) q = q.eq('agente', input.agente);
      const { data, error } = await q;
      if (error) return `Error al leer tareas: ${error.message}`;
      if (!data.length) return 'No hay tareas pendientes.';
      return data.map((t) => `#${t.id} · ${t.agente} · ${t.estado} · ${t.descripcion}`).join('\n');
    }
    if (nombre === 'cerrar_tarea') {
      const { error } = await base.from('tareas')
        .update({ estado: input.estado, actualizada: new Date().toISOString() }).eq('id', input.id);
      return error ? `Error: ${error.message}` : `Tarea #${input.id} marcada como ${input.estado}.`;
    }
    if (nombre === 'ver_agenda') {
      const lista = await eventos(`${input.desde}T00:00:00-03:00`, `${input.hasta}T23:59:59-03:00`);
      await setAhora('eleanor', 'Revisando tu agenda.', 'ok');
      if (!lista.length) return 'No hay eventos en esas fechas.';
      return lista.map((e: any) => `${e.todoElDia ? e.inicio + ' (todo el día)' : new Date(e.inicio).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${e.titulo}${e.lugar ? ' · ' + e.lugar : ''}`).join('\n');
    }
    if (nombre === 'crear_evento') {
      const todoElDia = !!input.todo_el_dia || input.inicio.length === 10;
      const fin = input.fin || (todoElDia ? undefined : new Date(horaBA(input.inicio).getTime() + 3600000 - 3 * 3600000).toISOString().slice(0, 16));
      let lugar = input.lugar;
      if (input.es_visita && !todoElDia) {
        const problema = reglaVisita(input.inicio, fin);
        if (problema) return `No lo agendé: ${problema}`;
        lugar = lugar || 'Av. Alvear 1491';
      }
      if (!todoElDia && !input.forzar) {
        const choques = await superposiciones(input.inicio, fin);
        if (choques.length) return `No lo agendé: se superpone con ${choques.map((c: any) => `"${c.titulo}"`).join(', ')}.`;
      }
      const link = await crearEvento({ titulo: input.titulo, inicio: input.inicio, fin, todoElDia, lugar, descripcion: input.descripcion });
      await setAhora('eleanor', `Agendó: ${input.titulo}.`, 'ok');
      return `Evento creado: ${input.titulo}. ${link || ''}`;
    }
    if (nombre === 'buscar_mails') {
      const res = await buscarCorreos(input.consulta);
      await setAhora('eleanor', 'Buscando mails que le pediste.', 'ok');
      if (!res.length) return 'No encontré mails con esa búsqueda.';
      return res.map((m: any) => `De: ${m.de}\nAsunto: ${m.asunto}\nFecha: ${m.fecha}\n${m.extracto}`).join('\n---\n');
    }
    if (nombre === 'buscar_en_drive') {
      const res = await buscarEnDrive(input.consulta);
      if (!res.length) return 'No encontré archivos con esa búsqueda.';
      return res.map((f: any) => `${f.name} · id ${f.id} · ${f.webViewLink}`).join('\n');
    }
    if (nombre === 'leer_documento') return await leerDocumento(input.id);
    if (nombre === 'registrar_venta') return await registrarVenta(input);
    if (nombre === 'registrar_compra') return await registrarCompra(input);
    if (nombre === 'registrar_gasto') return await registrarGasto(input);
    if (nombre === 'resumen_finanzas') return await resumenFinanzas(input?.mes);
    if (nombre === 'pedir_guion') { const g = await pedirGuion(input || {}, chatActual ?? undefined); return `Julian mandó el guion #${g.id}: ${g.titulo}.`; }
    if (nombre === 'pedir_ideas') { await pedirIdeas(input || {}, chatActual ?? undefined); return 'Julian mandó las ideas.'; }
    if (nombre === 'revisar_guion') return await revisarGuion(input, chatActual ?? undefined);
    if (nombre === 'marcar_guion') return await marcarGuion(input.id, input.estado);
    if (nombre === 'ver_guiones') return await listarGuiones();
    if (nombre === 'encargar_a_henry') {
      const base = process.env.URL_OFICINA || 'https://oficina-agentes-351k.vercel.app';
      const r = await fetch(`${base}/api/cron/henry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' },
        body: JSON.stringify({ pedido: input.pedido, tareaId: input.tarea_id }),
      });
      return r.ok ? 'Henry ya está trabajando; le manda el informe a Beltrán por Telegram cuando termine.' : `Henry no pudo arrancar (${r.status}).`;
    }
    if (nombre === 'publicar_historias') {
      const base = process.env.URL_OFICINA || 'https://oficina-agentes-351k.vercel.app';
      const r = await fetch(`${base}/api/cron/theo-historias?i=0&ya=1`, { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET || '' } });
      return r.ok ? 'Theo está publicando las historias; avisa al terminar.' : `Theo no pudo arrancar (${r.status}).`;
    }
    if (nombre === 'editar_reel') {
      const base = process.env.URL_OFICINA || 'https://oficina-agentes-351k.vercel.app';
      const r = await fetch(`${base}/api/cron/theo-editar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' },
        body: JSON.stringify({ guionId: input.guion_id, musica: input.musica, subtitulos: input.subtitulos !== false }),
      });
      return r.ok ? `Theo empezó a editar el guion #${input.guion_id}. Avisa por Telegram cuando esté (un par de minutos).` : `Theo no pudo arrancar (${r.status}).`;
    }
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
  return 'Herramienta desconocida.';
}

export async function responderArthur(chatId: number, texto: string): Promise<string> {
  const base = db();
  const conGoogle = await googleConectado().catch(() => false);
  const { data: previos } = await base
    .from('mensajes').select('rol, contenido').eq('chat_id', chatId)
    .order('creado', { ascending: false }).limit(20);

  // El mensaje actual ya está guardado: es el último del historial.
  const historial: Anthropic.MessageParam[] = (previos ?? []).reverse()
    .map((m) => ({ role: m.rol as 'user' | 'assistant', content: m.contenido }));
  while (historial.length && historial[0].role !== 'user') historial.shift();
  const mensajes: Anthropic.MessageParam[] = [];
  for (const m of historial) {
    const ultimo = mensajes[mensajes.length - 1];
    if (ultimo && ultimo.role === m.role) ultimo.content = `${ultimo.content}\n${m.content}`;
    else mensajes.push({ ...m });
  }
  if (!mensajes.length || mensajes[mensajes.length - 1].role !== 'user') mensajes.push({ role: 'user', content: texto });

  await setAhora('arthur', 'Conversando con Beltrán por Telegram.', 'ok');
  chatActual = chatId;
  const herramientas = conGoogle ? [...herramientasBase, ...herramientasGoogle, ...herramientasHenry, ...herramientasJulian, ...herramientasTheo] : [...herramientasBase, ...herramientasJulian];

  for (let vuelta = 0; vuelta < 8; vuelta++) {
    const respuesta = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 1200,
      system: sistema(conGoogle),
      tools: herramientas,
      messages: mensajes,
    });
    if (respuesta.stop_reason !== 'tool_use') {
      const final = respuesta.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text).join('\n').trim();
      await setAhora('arthur', 'Atento a tus mensajes en Telegram.', 'ok');
      return final || 'Listo.';
    }
    mensajes.push({ role: 'assistant', content: respuesta.content });
    const resultados: Anthropic.ToolResultBlockParam[] = [];
    for (const bloque of respuesta.content) {
      if (bloque.type === 'tool_use') {
        resultados.push({ type: 'tool_result', tool_use_id: bloque.id, content: await ejecutar(bloque.name, bloque.input) });
      }
    }
    mensajes.push({ role: 'user', content: resultados });
  }
  return 'Me trabé ordenando ese pedido. ¿Me lo repetís más corto?';
}
