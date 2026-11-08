import Anthropic from '@anthropic-ai/sdk';
import { db, setAhora } from './db';
import { anthropic, MODELO, fechaBA, PERFIL_BELTRAN } from './claude';
import {
  Correo, correosNuevos, etiquetaProcesado, marcarProcesado, responderCorreo,
  eventos, crearEvento, superposiciones, miEmail, horaBA,
} from './google';
import { avisar, enviarConBotones } from './telegram';
import { crearAprobacion } from './aprobaciones';

async function firma(): Promise<string> {
  const { data } = await db().from('credenciales').select('valor').eq('clave', 'eleanor_firma').maybeSingle();
  return data?.valor === 'asistente'
    ? 'Firmá como "Eleanor, asistente de Beltrán Symonds", escribiendo en tercera persona sobre Beltrán.'
    : 'Escribí en primera persona como si fueras Beltrán y firmá "Beltrán Symonds".';
}

const decidir: Anthropic.Tool = {
  name: 'decidir',
  description: 'Registra qué hacer con este mail.',
  input_schema: {
    type: 'object',
    properties: {
      accion: { type: 'string', enum: ['responder', 'informar', 'consultar', 'ignorar'] },
      resumen: { type: 'string', description: 'Una oración: quién escribe y qué quiere.' },
      respuesta: { type: 'string', description: 'Texto completo del mail de respuesta (solo si accion es responder o consultar).' },
      motivo_consulta: { type: 'string', description: 'Si accion es consultar: qué tiene que decidir Beltrán.' },
      pendiente: { type: 'string', description: 'Algo concreto que Beltrán tiene que hacer, si lo hay.' },
      eventos: {
        type: 'array',
        description: 'Fechas concretas y confirmadas que conviene agendar (entregas, parciales, reuniones ya acordadas).',
        items: {
          type: 'object',
          properties: {
            titulo: { type: 'string' },
            inicio: { type: 'string', description: 'AAAA-MM-DDTHH:MM hora de Buenos Aires, o AAAA-MM-DD si es todo el día' },
            fin: { type: 'string' },
            todo_el_dia: { type: 'boolean' },
          },
          required: ['titulo', 'inicio'],
        },
      },
    },
    required: ['accion', 'resumen'],
  },
};

async function sistema(agendaTexto: string) {
  return `Sos Eleanor Vance, secretaria personal de Beltrán. Organizada, discreta y formal.
${PERFIL_BELTRAN}
Fecha y hora en Buenos Aires: ${fechaBA()}.
Agenda de Beltrán de los próximos 7 días:
${agendaTexto || '(sin eventos)'}

Revisás un mail que llegó a su casilla institucional y decidís con la herramienta decidir:
- ignorar: publicidad, newsletters, promociones, notificaciones automáticas sin nada que hacer.
- informar: información útil que no necesita respuesta (avisos de cátedra, comunicados, confirmaciones, mails masivos o de listas con datos relevantes).
- responder: mails personales dirigidos a Beltrán que se pueden contestar sin comprometerlo: acusar recibo, agradecer, confirmar que recibió algo, responder con información que está en el propio mail. La respuesta sale sin que Beltrán la vea, así que tiene que ser segura.
- consultar: todo lo que necesite una decisión de Beltrán (aceptar o proponer reuniones u horarios, plata, compras y ventas, notas, entregas, trámites, temas personales o delicados, opiniones). Redactá igual un borrador de respuesta para que él lo apruebe.

Reglas para las respuestas:
- Mismo idioma que el mail. Tono formal y cordial, breve. Saludo y despedida acordes.
- ${await firma()}
- Nunca inventes datos, nunca comprometas asistencia, fechas, plata ni entregas: eso es consultar.
- Nunca respondas a listas de distribución, mails masivos ni direcciones no-reply.
Si hay fechas concretas y relevantes (parcial, entrega, reunión confirmada), agregalas en eventos.`;
}

function agendaComoTexto(lista: any[]) {
  return lista.map((e) => `${e.todoElDia ? e.inicio : new Date(e.inicio).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${e.titulo}`).join('\n');
}

function nombre(de: string) {
  return (de.split('<')[0].replace(/"/g, '').trim() || de).slice(0, 60);
}

export async function revisarCorreo() {
  const base = db();
  const etiqueta = await etiquetaProcesado();
  const nuevos = await correosNuevos(8);
  if (!nuevos.length) return { procesados: 0 };

  await setAhora('eleanor', `Leyendo ${nuevos.length} ${nuevos.length === 1 ? 'mail nuevo' : 'mails nuevos'}.`, 'ok');
  const ahora = new Date();
  const agenda = await eventos(ahora.toISOString(), new Date(ahora.getTime() + 7 * 86400000).toISOString()).catch(() => []);
  const prompt = await sistema(agendaComoTexto(agenda));
  const yo = (await miEmail()).toLowerCase();

  const respondidos: string[] = [], informados: string[] = [], pendientes: string[] = [], agendados: string[] = [];
  let consultas = 0;

  for (const c of nuevos) {
    const { data: ya } = await base.from('correos').select('id').eq('id', c.id).maybeSingle();
    if (ya) { await marcarProcesado(c.id, etiqueta); continue; }
    if (yo && c.de.toLowerCase().includes(yo)) { await marcarProcesado(c.id, etiqueta); continue; }

    let d: any;
    try {
      const r = await anthropic.messages.create({
        model: MODELO,
        max_tokens: 1500,
        system: prompt,
        tools: [decidir],
        tool_choice: { type: 'tool', name: 'decidir' },
        messages: [{
          role: 'user',
          content: `De: ${c.de}\nPara: ${c.para}\nCC: ${c.cc}\nFecha: ${c.fecha}\nAsunto: ${c.asunto}\nEs lista o masivo: ${c.lista || c.masivo ? 'sí' : 'no'}\n\n${c.cuerpo}`,
        }],
      });
      d = (r.content.find((b) => b.type === 'tool_use') as Anthropic.ToolUseBlock)?.input;
    } catch (e) {
      console.error('Eleanor no pudo decidir', e);
      continue; // se reintenta en la próxima revisión
    }
    if (!d) continue;

    // Barrera de seguridad: nunca responder sola a listas o masivos.
    if (d.accion === 'responder' && (c.lista || c.masivo || !d.respuesta)) d.accion = d.respuesta ? 'consultar' : 'informar';

    const quien = nombre(c.de);
    if (d.accion === 'responder') {
      try {
        await responderCorreo(c, d.respuesta);
        respondidos.push(`${quien} — "${c.asunto}": ${d.resumen}\n  Respondí: ${d.respuesta.replace(/\s+/g, ' ').slice(0, 220)}${d.respuesta.length > 220 ? '…' : ''}`);
      } catch (e: any) {
        d.accion = 'consultar';
        d.motivo_consulta = `No pude enviar la respuesta automática (${e.message}).`;
      }
    }
    if (d.accion === 'consultar') {
      const texto = `Eleanor necesita tu decisión\n\nDe: ${quien}\nAsunto: ${c.asunto}\n${d.resumen}\n${d.motivo_consulta ? `\nPara decidir: ${d.motivo_consulta}\n` : ''}${d.respuesta ? `\nRespuesta propuesta:\n${d.respuesta}` : ''}`;
      const id = await crearAprobacion('eleanor', texto, 'respuesta_mail', {
        correo: { id: c.id, hilo: c.hilo, de: c.de, asunto: c.asunto, messageId: c.messageId, referencias: c.referencias },
        borrador: d.respuesta || '',
      });
      const botones = d.respuesta
        ? [{ texto: 'Enviar respuesta', dato: `apr:${id}:si` }, { texto: 'No responder', dato: `apr:${id}:no` }]
        : [{ texto: 'Entendido', dato: `apr:${id}:no` }];
      const msgId = await enviarConBotones(texto, botones);
      if (msgId) await base.from('aprobaciones').update({ telegram_msg_id: msgId }).eq('id', id);
      consultas++;
    }
    if (d.accion === 'informar') informados.push(`${quien} — "${c.asunto}": ${d.resumen}`);
    if (d.pendiente) pendientes.push(d.pendiente);

    for (const ev of d.eventos || []) {
      try {
        const todoElDia = !!ev.todo_el_dia || ev.inicio.length === 10;
        const dia = ev.inicio.slice(0, 10);
        const delDia = await eventos(`${dia}T00:00:00-03:00`, `${dia}T23:59:59-03:00`);
        if (delDia.some((x: any) => x.titulo.toLowerCase() === ev.titulo.toLowerCase())) continue;
        if (!todoElDia) {
          const fin = ev.fin || new Date(horaBA(ev.inicio).getTime() - 2 * 3600000).toISOString().slice(0, 16);
          const choques = await superposiciones(ev.inicio, fin);
          if (choques.length) { pendientes.push(`"${ev.titulo}" (${ev.inicio.replace('T', ' ')}) choca con ${choques.map((x: any) => `"${x.titulo}"`).join(', ')}. No lo agendé.`); continue; }
          await crearEvento({ titulo: ev.titulo, inicio: ev.inicio, fin, descripcion: `Del mail de ${quien}: ${c.asunto}` });
        } else {
          await crearEvento({ titulo: ev.titulo, inicio: dia, todoElDia: true, descripcion: `Del mail de ${quien}: ${c.asunto}` });
        }
        agendados.push(`${ev.titulo} · ${ev.inicio.replace('T', ' ')}`);
      } catch (e) { console.error('No se pudo agendar', e); }
    }

    await base.from('correos').insert({
      id: c.id, hilo: c.hilo, de: c.de, asunto: c.asunto, accion: d.accion, resumen: d.resumen,
      respuesta: d.accion === 'responder' ? d.respuesta : null,
    });
    await marcarProcesado(c.id, etiqueta);
  }

  const partes: string[] = [];
  if (respondidos.length) partes.push(`Respondí:\n• ${respondidos.join('\n• ')}`);
  if (informados.length) partes.push(`Para que sepas:\n• ${informados.join('\n• ')}`);
  if (agendados.length) partes.push(`Agendé:\n• ${agendados.join('\n• ')}`);
  if (pendientes.length) partes.push(`Tenés que:\n• ${pendientes.join('\n• ')}`);
  if (partes.length) await avisar(`Eleanor revisó tu mail\n\n${partes.join('\n\n')}`);

  const { count } = await base.from('aprobaciones').select('id', { count: 'exact', head: true }).eq('agente', 'eleanor').eq('estado', 'pendiente');
  await setAhora('eleanor',
    count ? `${count} ${count === 1 ? 'mail espera' : 'mails esperan'} tu decisión.` : `Revisó el mail a las ${new Date().toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit' })}. Todo al día.`,
    count ? 'wait' : 'ok');
  return { procesados: nuevos.length, respondidos: respondidos.length, consultas, informados: informados.length };
}

export async function resumenDiario() {
  const base = db();
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
  const lista = await eventos(`${hoy}T00:00:00-03:00`, `${hoy}T23:59:59-03:00`).catch(() => []);
  const { data: tareas } = await base.from('tareas').select('agente, descripcion').in('estado', ['pendiente', 'en_curso']).limit(15);
  const { data: aprob } = await base.from('aprobaciones').select('agente, texto').eq('estado', 'pendiente');
  const desde = new Date(Date.now() - 86400000).toISOString();
  const { data: correos } = await base.from('correos').select('accion').gte('creado', desde);

  const agendaTxt = lista.length
    ? lista.map((e: any) => `• ${e.todoElDia ? 'Todo el día' : new Date(e.inicio).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit' })} · ${e.titulo}`).join('\n')
    : '• Sin eventos.';
  const resp = (correos || []).filter((c) => c.accion === 'responder').length;
  const partes = [
    `Buen día, Beltrán. Tu día, según Eleanor:`,
    `Agenda de hoy:\n${agendaTxt}`,
    `Mail en las últimas 24 h: ${correos?.length || 0} revisados, ${resp} respondidos.`,
  ];
  if (aprob?.length) partes.push(`Esperan tu decisión: ${aprob.length}. Las tenés más arriba en este chat y en la oficina.`);
  if (tareas?.length) partes.push(`Tareas en cola:\n${tareas.map((t) => `• ${t.agente}: ${t.descripcion}`).join('\n')}`);
  await avisar(partes.join('\n\n'));
}
