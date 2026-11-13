import Anthropic from '@anthropic-ai/sdk';
import { db, setAhora, AgenteId } from './db';
import { anthropic, MODELO, fechaBA, PERFIL_BELTRAN } from './claude';
import { crearAprobacion, resolverAprobacion } from './aprobaciones';
import { revisarPost } from './oliver';
import { enviarConBotones } from './telegram';
import { registrarVenta, registrarCompra, registrarGasto, resumenFinanzas } from './henry';
import { pedirGuion, pedirIdeas, revisarGuion, marcarGuion, listarGuiones } from './julian';
import { googleConectado, eventos, crearEvento, superposiciones, buscarCorreos, buscarEnDrive, leerDocumento, horaBA } from './google';

const EQUIPO = `
- eleanor (Eleanor Vance), secretaria personal: mail institucional, Google Calendar y Drive. Coordina las visitas con Margaret.
- margaret (Margaret Ellsworth), recepcionista de beltranrelojes: responde mensajes directos de Instagram con info y precio publicado. Las ofertas distintas al precio se derivan a Beltrán. Las visitas se confirman con aprobación de Beltrán.
- julian (Julian Hart), creador de contenido: ideas y guiones de videos cortos informativos, textos e historias.
- theo (Theo Lang), editor de video: edita lo que graba Beltrán, se lo muestra antes de publicar, sube historias de stock cada dos días.
- victoria (Victoria Ashford), marketing: mide la cuenta de Instagram, le marca la dirección a Julian y Theo para crecer y maneja los anuncios (hasta 30 USD por mes, cada campaña con aprobación de Beltrán).
- oliver (Oliver Pemberton), LinkedIn: escribe las publicaciones del perfil personal de Beltrán (una por semana, los martes) y cada una sale solo con su aprobación. Para pedirle una, usá pedir_post_linkedin; para cambiar un borrador, revisar_post_linkedin.
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
- Mails: Eleanor puede mandar mails nuevos desde la casilla de Beltrán. Si te pide escribirle a alguien, buscá la dirección con buscar_mails y usá redactar_mail; nunca digas que no se pueden enviar mails. Si Beltrán dice "enviá", "mandalo" o "aprobado" sobre algo pendiente, usá resolver_pendiente (sin crear un borrador nuevo).
- Victoria está conectada: cualquier pedido de marketing, crecimiento de la cuenta, estadísticas, anuncios o estrategia de contenido pasáselo con encargar_a_victoria. Ella trabaja sola, coordina con Julian y le manda el informe y las propuestas de anuncio a Beltrán por Telegram. Los lunes manda su informe semanal sola.
- Theo está conectado: cuando Beltrán diga que subió las tomas de un guion (carpeta "Videos para editar/Guion N" en el Drive), usá editar_reel. Si no dijo si quiere música libre de derechos (Theo la pone y publica cuando Beltrán aprueba) o sin música (para que él ponga un audio de tendencia y publique), preguntale antes. Theo avisa por Telegram cuando el reel está listo. Videos de historia: si Beltrán pide un video de historia de un reloj, pedile el guion a Julian con pedir_guion y formato "historia"; cuando avise que subió la toma (y los apoyos) a "Guion N", usá editar_historia. Si Beltrán deja un video ya terminado suelto en "Videos para editar" y pide la marca de agua, el logo, o tapar/sacar la marca de Kling (con recuadro blanco), usá marca_de_agua (recuadro: true para tapar la esquina). Nunca lo dejes como tarea en cola. Las historias del stock se publican solas cada dos días a las 18; si Beltrán pide subirlas ya, usá publicar_historias (una por cada reloj con fotos, y Theo avisa al terminar).

Reglas:
- Todos los agentes están conectados: hacé los pedidos con sus herramientas, no con crear_tarea. crear_tarea es solo para dejar anotado un pendiente que Beltrán quiere recordar y que ninguna herramienta resuelve.
- No inventes resultados, datos de mercado, mails ni turnos. Si no sabés algo, decilo.
- Si un pedido es ambiguo, hacé una sola pregunta corta antes de actuar.
- Las fechas y horas que usás en las herramientas son de Buenos Aires, en formato AAAA-MM-DDTHH:MM.
- Antes de agendar, crear_evento ya revisa superposiciones. Si hay choque, contale a Beltrán y proponé otro horario; solo forzá si él lo pide.
- Confirmá en una línea cada cosa que hacés.`;
}

const AGENTES_COLA = ['eleanor', 'margaret', 'julian', 'theo', 'henry', 'victoria', 'oliver'];

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
    name: 'resolver_pendiente',
    description: 'Aprueba o rechaza algo que espera la aprobación de Beltrán (un mail, una visita, un reel, un anuncio) cuando él lo dice por mensaje en vez de tocar el botón. Sin id, toma el pendiente más reciente del tipo indicado.',
    input_schema: {
      type: 'object',
      properties: {
        aprobar: { type: 'boolean' },
        tipo: { type: 'string', enum: ['mail_nuevo', 'respuesta_mail', 'visita', 'reel', 'campana'] },
        id: { type: 'number' },
      },
      required: ['aprobar'],
    },
  },
  {
    name: 'redactar_mail',
    description: 'Prepara un mail NUEVO desde la casilla de Beltrán (no una respuesta) y se lo manda a Beltrán por Telegram con botones Enviar / No enviar. No sale nada sin su OK. Si no sabés la dirección, buscala antes con buscar_mails.',
    input_schema: {
      type: 'object',
      properties: {
        para: { type: 'string', description: 'Dirección de mail del destinatario' },
        asunto: { type: 'string' },
        cuerpo: { type: 'string', description: 'Texto completo del mail, en primera persona de Beltrán y firmado "Beltrán Symonds Dagnino", salvo que él pida que lo firme Eleanor.' },
      },
      required: ['para', 'asunto', 'cuerpo'],
    },
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
    name: 'pedir_post_linkedin',
    description: 'Oliver escribe una publicación para el LinkedIn personal de Beltrán (tema opcional) y se la manda por Telegram con botones Publicar / No publicar.',
    input_schema: { type: 'object', properties: { tema: { type: 'string' }, notas: { type: 'string' } } },
  },
  {
    name: 'revisar_post_linkedin',
    description: 'Oliver reescribe el último borrador de LinkedIn (o el número indicado) con los cambios que pide Beltrán y lo vuelve a mandar para aprobar.',
    input_schema: { type: 'object', properties: { cambios: { type: 'string' }, id: { type: 'number' } }, required: ['cambios'] },
  },
  {
    name: 'editar_historia',
    description: 'Theo edita un video de HISTORIA (guion de Julian con tramos [A CÁMARA] / [VOZ EN OFF] y apoyos B1, B2…): transcribe la toma de Beltrán, corta silencios, pone los apoyos sobre la voz en off, subtítulos palabra por palabra y logo, y lo manda para aprobar. La toma y los apoyos van en "Videos para editar/Guion N".',
    input_schema: {
      type: 'object',
      properties: { guion_id: { type: 'number' }, musica: { type: 'string', enum: ['libre', 'sin'], description: 'libre = música de fondo bajita de la carpeta de Theo; sin = solo la voz (Beltrán agrega audio en Instagram)' } },
      required: ['guion_id'],
    },
  },
  {
    name: 'marca_de_agua',
    description: 'Theo toma un video ya terminado (por ejemplo hecho con IA) que Beltrán dejó suelto en "Videos para editar", lo pasa a formato Reel, le pone el logo chico abajo a la derecha y Julian sugiere qué agregarle. Avisa por Telegram.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Parte del nombre del archivo, si Beltrán lo dijo. Si no, usa el más reciente.' },
        descripcion: { type: 'string', description: 'Qué muestra el video, según Beltrán (reloj, estilo).' },
        recuadro: { type: 'boolean', description: 'true si pide tapar la marca de Kling u otra esquina con un rectángulo blanco y el logo encima.' },
      },
    },
  },
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
  {
    name: 'encargar_a_victoria',
    description: 'Le pasa a Victoria un pedido de marketing (estadísticas, crecimiento, anuncios, estrategia de contenido). Trabaja en segundo plano y le escribe a Beltrán por Telegram.',
    input_schema: { type: 'object', properties: { pedido: { type: 'string', description: 'El pedido completo de Beltrán.' } }, required: ['pedido'] },
  },
  { name: 'publicar_historias_de_prueba', description: 'Publica en Instagram las historias de prueba que Theo armó en la última hora y que Beltrán ya vio y aprobó, sin volver a armarlas.', input_schema: { type: 'object', properties: {} } },
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
    if (nombre === 'encargar_a_victoria') {
      const base = process.env.URL_OFICINA || 'https://oficina-agentes-351k.vercel.app';
      const r = await fetch(`${base}/api/cron/victoria`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' },
        body: JSON.stringify({ pedido: input.pedido }),
      });
      return r.ok ? 'Victoria ya está trabajando; le escribe a Beltrán cuando termine.' : `Victoria no pudo arrancar (${r.status}).`;
    }
    if (nombre === 'publicar_historias_de_prueba') {
      const base = process.env.URL_OFICINA || 'https://oficina-agentes-351k.vercel.app';
      const r = await fetch(`${base}/api/cron/theo-historias?armadas=1`, { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET || '' } });
      return r.ok ? 'Theo está publicando las historias de prueba; avisa al terminar.' : `Theo no pudo arrancar (${r.status}).`;
    }
    if (nombre === 'publicar_historias') {
      const base = process.env.URL_OFICINA || 'https://oficina-agentes-351k.vercel.app';
      const r = await fetch(`${base}/api/cron/theo-historias?i=0&ya=1`, { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET || '' } });
      return r.ok ? 'Theo está publicando las historias; avisa al terminar.' : `Theo no pudo arrancar (${r.status}).`;
    }
    if (nombre === 'resolver_pendiente') {
      let id = input.id as number | undefined;
      if (!id) {
        let q = db().from('aprobaciones').select('id').eq('estado', 'pendiente').order('id', { ascending: false }).limit(1);
        if (input.tipo) q = q.eq('tipo', input.tipo);
        const { data } = await q;
        id = data?.[0]?.id;
      }
      if (!id) return 'No hay nada pendiente de ese tipo.';
      return await resolverAprobacion(id, !!input.aprobar);
    }
    if (nombre === 'redactar_mail') {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(input.para || ''))) return 'Falta una dirección de mail válida: buscala con buscar_mails o pedísela a Beltrán.';
      const texto = `Eleanor — mail listo para enviar\nPara: ${input.para}\nAsunto: ${input.asunto}\n\n${input.cuerpo}`;
      const id = await crearAprobacion('eleanor', texto, 'mail_nuevo', { para: input.para, asunto: input.asunto, cuerpo: input.cuerpo });
      const msg = await enviarConBotones(texto, [{ texto: 'Enviar', dato: `apr:${id}:si` }, { texto: 'No enviar', dato: `apr:${id}:no` }]);
      if (msg) await db().from('aprobaciones').update({ telegram_msg_id: msg }).eq('id', id);
      return 'Borrador enviado a Beltrán con botones para enviar. No repitas el texto del mail en tu respuesta: decile solo que lo tiene arriba para aprobar.';
    }
    if (nombre === 'pedir_post_linkedin') {
      const base = process.env.URL_OFICINA || 'https://oficina-agentes-351k.vercel.app';
      const r = await fetch(`${base}/api/cron/oliver`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' }, body: JSON.stringify({ tema: input.tema, notas: input.notas }) });
      return r.ok ? 'Oliver está escribiendo la publicación; te la manda por Telegram para aprobar.' : `Oliver no pudo arrancar (${r.status}).`;
    }
    if (nombre === 'revisar_post_linkedin') return await revisarPost({ id: input.id, cambios: input.cambios });
    if (nombre === 'editar_historia') {
      const base = process.env.URL_OFICINA || 'https://oficina-agentes-351k.vercel.app';
      const r = await fetch(`${base}/api/cron/theo-editar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' },
        body: JSON.stringify({ tipo: 'historia', guionId: input.guion_id, musica: input.musica || 'sin' }),
      });
      return r.ok ? `Theo está editando el video de historia del guion #${input.guion_id}; tarda unos minutos y avisa por Telegram.` : `Theo no pudo arrancar (${r.status}).`;
    }
    if (nombre === 'marca_de_agua') {
      const base = process.env.URL_OFICINA || 'https://oficina-agentes-351k.vercel.app';
      const r = await fetch(`${base}/api/cron/theo-editar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' },
        body: JSON.stringify({ tipo: 'marca', nombre: input.nombre, descripcion: input.descripcion, recuadro: !!input.recuadro }),
      });
      return r.ok ? 'Theo le está poniendo la marca de agua y Julian lo va a mirar; avisan por Telegram.' : `Theo no pudo arrancar (${r.status}).`;
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

  // El sistema se arma una sola vez por conversación: si cambia entre vueltas (por la hora), Claude rechaza los bloques de razonamiento.
  const sistemaFijo = sistema(conGoogle);
  for (let vuelta = 0; vuelta < 8; vuelta++) {
    const respuesta = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 1200,
      system: sistemaFijo,
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
