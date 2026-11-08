import Anthropic from '@anthropic-ai/sdk';
import { db, setAhora, AgenteId } from './db';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODELO = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';

const EQUIPO = `
- eleanor (Eleanor Vance), secretaria personal: mail institucional, Google Calendar y Drive. Coordina las visitas con Margaret.
- margaret (Margaret Ellsworth), recepcionista de beltranrelojes: responde mensajes directos de Instagram con info y precio publicado. Las ofertas distintas al precio se derivan a Beltrán. Las visitas (Av. Alvear 1491; nunca después de las 18; martes y jueves desde las 15) se confirman con aprobación de Beltrán.
- julian (Julian Hart), creador de contenido: ideas y guiones de videos cortos informativos, textos e historias.
- theo (Theo Lang), editor de video: edita lo que graba Beltrán, se lo muestra antes de publicar, sube historias de stock cada dos días.
- charles (Charles Pemberton), analista de mercado: precios en Chrono24, reloje.ar y competencia. Solo lee.`;

function sistema() {
  const ahora = new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'full', timeStyle: 'short',
  }).format(new Date());
  return `Sos Arthur Whitmore, jefe de la oficina de agentes de IA de Beltrán Symonds Dagnino. La oficina trabaja para su negocio de relojes (beltranrelojes) y como secretaría personal.
Personalidad: sereno, metódico, formal y cordial. Hablás poco y decidís rápido. Escribís en español rioplatense, con voseo, en mensajes cortos aptos para Telegram (sin markdown, sin tablas).
Fecha y hora en Buenos Aires: ${ahora}.

Tu trabajo: recibir los pedidos de Beltrán, repartirlos al agente correcto con la herramienta crear_tarea, contarle qué hay pendiente y mantener el orden.
Equipo:${EQUIPO}

Reglas:
- Por ahora solo vos estás conectado. Los demás agentes todavía no ejecutan nada: sus tareas quedan en cola hasta que se conecten. Decíselo a Beltrán con naturalidad la primera vez que corresponda, sin repetirlo en cada mensaje.
- No inventes resultados, datos de mercado, mails ni turnos. Si no sabés algo, decilo.
- Si un pedido es ambiguo, hacé una sola pregunta corta antes de crear la tarea.
- Confirmá en una línea cada tarea que creás, nombrando al agente.`;
}

const herramientas: Anthropic.Tool[] = [
  {
    name: 'crear_tarea',
    description: 'Crea una tarea para un agente de la oficina. Usala cuando Beltrán pida algo que le corresponde a otro agente.',
    input_schema: {
      type: 'object',
      properties: {
        agente: { type: 'string', enum: ['eleanor', 'margaret', 'julian', 'theo', 'charles'] },
        descripcion: { type: 'string', description: 'Qué tiene que hacer, en una o dos oraciones claras.' },
      },
      required: ['agente', 'descripcion'],
    },
  },
  {
    name: 'ver_tareas',
    description: 'Lista las tareas pendientes o en curso, de un agente o de toda la oficina.',
    input_schema: {
      type: 'object',
      properties: { agente: { type: 'string', enum: ['eleanor', 'margaret', 'julian', 'theo', 'charles'] } },
    },
  },
  {
    name: 'cerrar_tarea',
    description: 'Marca una tarea como hecha o cancelada cuando Beltrán lo indica.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        estado: { type: 'string', enum: ['hecha', 'cancelada'] },
      },
      required: ['id', 'estado'],
    },
  },
];

async function ejecutar(nombre: string, input: any): Promise<string> {
  const base = db();
  if (nombre === 'crear_tarea') {
    const { data, error } = await base
      .from('tareas')
      .insert({ agente: input.agente, descripcion: input.descripcion, origen: 'arthur' })
      .select('id')
      .single();
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
  return 'Herramienta desconocida.';
}

export async function responderArthur(chatId: number, texto: string): Promise<string> {
  const base = db();
  const { data: previos } = await base
    .from('mensajes').select('rol, contenido').eq('chat_id', chatId)
    .order('creado', { ascending: false }).limit(20);

  const historial: Anthropic.MessageParam[] = (previos ?? []).reverse()
    .map((m) => ({ role: m.rol as 'user' | 'assistant', content: m.contenido }));
  // La API necesita que la conversación empiece por el usuario y alterne roles.
  while (historial.length && historial[0].role !== 'user') historial.shift();
  const mensajes: Anthropic.MessageParam[] = [];
  for (const m of historial) {
    const ultimo = mensajes[mensajes.length - 1];
    if (ultimo && ultimo.role === m.role) ultimo.content = `${ultimo.content}\n${m.content}`;
    else mensajes.push({ ...m });
  }
  if (mensajes.length && mensajes[mensajes.length - 1].role === 'user') {
    mensajes[mensajes.length - 1].content = `${mensajes[mensajes.length - 1].content}\n${texto}`;
  } else {
    mensajes.push({ role: 'user', content: texto });
  }

  await setAhora('arthur', 'Conversando con Beltrán por Telegram.', 'ok');

  for (let vuelta = 0; vuelta < 6; vuelta++) {
    const respuesta = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 1024,
      system: sistema(),
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
