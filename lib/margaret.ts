import Anthropic from '@anthropic-ai/sdk';
import { db, setAhora } from './db';
import { anthropic, MODELO, fechaBA } from './claude';
import { stockDisponible, stockComoTexto, carpetaDelReloj } from './stock';
import { huecosDelDia, horaBA } from './google';
import { enviarDM, nombreDe, enviarMedia } from './instagram';
import { avisar, enviarConBotones } from './telegram';
import { crearAprobacion } from './aprobaciones';
import { analizarOferta } from './henry';

const DIRECCION = 'Av. Alvear 1491';

type ConfigVisitas = { inicio: number; fin: number; dias: number[] };
async function configVisitas(): Promise<ConfigVisitas> {
  const { data } = await db().from('credenciales').select('valor').eq('clave', 'visitas_config').maybeSingle();
  try { return { inicio: 10, fin: 18, dias: [1, 2, 3, 4, 5, 6], ...(data?.valor ? JSON.parse(data.valor) : {}) }; }
  catch { return { inicio: 10, fin: 18, dias: [1, 2, 3, 4, 5, 6] }; }
}
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function sistema(nombreCliente: string) {
  return `Sos Margaret Ellsworth, recepcionista de beltranrelojes, el negocio de compra y venta de relojes de Beltrán. Atendés los mensajes directos de Instagram.
Fecha y hora en Buenos Aires: ${fechaBA()}.
${nombreCliente ? `El cliente se llama o figura como: ${nombreCliente}.` : ''}

Tono: cálido, cercano y humano, como una persona del local escribiendo por WhatsApp, en español rioplatense con voseo. Tratás al cliente de "querido" (o "querida" si es evidente). Saludás según la hora solo en el primer mensaje de la conversación, no en cada respuesta.
Largo: CORTO Y CONCRETO. Una a tres líneas como máximo. Respondé exactamente lo que preguntaron, sin introducciones, sin repetir datos que ya diste y sin cerrar con fórmulas ("quedo a disposición", "cualquier cosa avisame"). Solo si piden la info completa del reloj podés listar los datos en pocas líneas. Sin markdown ni asteriscos. Ejemplos del estilo (no para copiar): "Buenas tardes querido! Sí, lo tengo. Está 1.800 USD." / "Querido, la caja es de 34 mm." / "Dale, te paso fotos."

Qué atendés (muy importante):
- Solo atendés en detalle los relojes que figuran en ver_stock. Es una selección chica de piezas con fotos.
- Si el cliente pide algo que no podés resolver (otro reloj o marca, tasar o vender un reloj suyo, la página web, temas que no son de estas piezas), contestale una sola frase corta y humana derivándolo, por ejemplo "Dale querido, ahí te derivo con Beltrán así lo ve él." o "Buenísimo, se lo paso a Beltrán que te escribe él.", y usá derivar_a_beltran.
- Si el mensaje es solo un saludo o "info" sin decir qué reloj le interesa, saludá y preguntale en una línea por qué reloj consulta.

Cómo trabajás:
- Usá ver_stock y respondé solo con lo que figura ahí.
- Si dos piezas parecen iguales con distinto precio, usá el campo Detalle para explicar la diferencia (por ejemplo, el color del dial).
- Si te piden fotos o videos, o si mostrarlos ayuda, usá enviar_fotos con el reloj. Las fotos llegan en mensajes aparte: tu texto puede decir "Te paso las fotos".
- Si un dato no está en el stock, no lo inventes: decí en una frase que lo consultás con Beltrán ("Dejame que lo chequeo con Beltrán y te digo.") y usá avisar_a_beltran.
- Precios: solo el precio publicado. Si figura "a consultar", decí que se lo consultás a Beltrán y usá avisar_a_beltran.
- Ofertas o pedidos de descuento, permutas, formas de pago o cuotas especiales: una frase corta del estilo "Dale querido, eso lo ve Beltrán directamente, ahí te derivo." y usá derivar_oferta.
- Visitas para ver relojes: son en ${DIRECCION}. Para proponer horarios usá ver_horarios; no ofrezcas horarios que la herramienta no devuelva. Cuando el cliente elija día y hora, usá proponer_visita y decile en una línea que se la confirmás enseguida. Nunca confirmes una visita vos.
- Nunca hables de costos, márgenes, ganancias, inversión ni de cuánto pagó Beltrán por un reloj.
- No prometas envíos, garantías, autenticaciones ni plazos que no figuren en el stock: consultalo con Beltrán.
`;
}

const herramientas: Anthropic.Tool[] = [
  {
    name: 'ver_stock',
    description: 'Lista los relojes disponibles con sus datos públicos y precios. Podés filtrar por texto (marca, modelo o referencia) y por precio máximo en USD.',
    input_schema: { type: 'object', properties: { buscar: { type: 'string' }, precio_maximo: { type: 'number' } } },
  },
  {
    name: 'ver_horarios',
    description: 'Devuelve los horarios libres para una visita en un día (hora de Buenos Aires).',
    input_schema: { type: 'object', properties: { dia: { type: 'string', description: 'AAAA-MM-DD' } }, required: ['dia'] },
  },
  {
    name: 'proponer_visita',
    description: 'Le pide a Beltrán que apruebe una visita. Usala cuando el cliente eligió día y hora.',
    input_schema: {
      type: 'object',
      properties: {
        inicio: { type: 'string', description: 'AAAA-MM-DDTHH:MM, hora de Buenos Aires' },
        reloj: { type: 'string', description: 'Qué reloj quiere ver' },
        nombre: { type: 'string', description: 'Nombre del cliente, si lo dio' },
      },
      required: ['inicio'],
    },
  },
  {
    name: 'derivar_oferta',
    description: 'Avisa a Beltrán de una oferta, pedido de descuento, permuta o negociación.',
    input_schema: {
      type: 'object',
      properties: { reloj: { type: 'string' }, detalle: { type: 'string', description: 'Qué ofrece o pide el cliente, con montos si los dio' } },
      required: ['detalle'],
    },
  },
  {
    name: 'enviar_fotos',
    description: 'Manda por Instagram las fotos (hasta 4) y el video de un reloj del stock.',
    input_schema: { type: 'object', properties: { reloj: { type: 'string', description: 'Marca, modelo, referencia o detalle que lo identifique (ej. "Tudor dial blanco")' } }, required: ['reloj'] },
  },
  {
    name: 'derivar_a_beltran',
    description: 'La consulta no es sobre un reloj de tu stock o no la podés resolver: Beltrán recibe un aviso para seguir él. Igual le contestás al cliente una frase corta derivándolo.',
    input_schema: { type: 'object', properties: { motivo: { type: 'string', description: 'Qué pidió el cliente, en una línea' } }, required: ['motivo'] },
  },
  {
    name: 'avisar_a_beltran',
    description: 'Le avisa a Beltrán algo que necesita su respuesta (dato que falta, precio a consultar, consulta mayorista, etc.).',
    input_schema: { type: 'object', properties: { motivo: { type: 'string' } }, required: ['motivo'] },
  },
];

async function ejecutar(nombre: string, input: any, igUsuario: string, cliente: string): Promise<string> {
  try {
    if (nombre === 'ver_stock') {
      let lista = await stockDisponible();
      if (input?.buscar) {
        const q = String(input.buscar).toLowerCase();
        lista = lista.filter((r) => [r['Marca'], r['Modelo'], r['Referencia']].join(' ').toLowerCase().includes(q));
      }
      if (input?.precio_maximo) {
        const precio = (r: Record<string, string>) => parseFloat((r['Precio con descuento'] || r['Precio'] || r['Precio de lista'] || '').replace(/[^\d.]/g, ''));
        lista = lista.filter((r) => !isNaN(precio(r)) && precio(r) <= Number(input.precio_maximo));
      }
      return stockComoTexto(lista);
    }
    if (nombre === 'enviar_fotos') {
      const lista = await stockDisponible();
      const q = String(input.reloj || '').toLowerCase().split(/\s+/).filter((w: string) => w.length > 1);
      const puntos = (r: Record<string, string>) => q.filter((w: string) => Object.values(r).join(' ').toLowerCase().includes(w)).length;
      const ordenados = [...lista].sort((a, b) => puntos(b) - puntos(a));
      const r = ordenados[0];
      if (!r || !puntos(r)) return 'No encontré ese reloj en el stock con fotos.';
      if (ordenados[1] && puntos(ordenados[1]) === puntos(r)) return `Hay más de un reloj que coincide (${ordenados.filter((x) => puntos(x) === puntos(r)).map((x) => `${x['Modelo']} ${x['Detalle'] || x['Precio']}`).join(' / ')}). Preguntale al cliente cuál.`;
      const c = carpetaDelReloj(r);
      if (!c) return 'Ese reloj no tiene fotos cargadas.';
      const base = process.env.URL_OFICINA || 'https://oficina-agentes-351k.vercel.app';
      let enviadas = 0, fallas = 0;
      for (const id of c.fotos.slice(0, 4)) { try { await enviarMedia(igUsuario, 'image', `${base}/api/foto/${id}`); enviadas++; } catch (e) { fallas++; console.error('foto', e); } }
      for (const id of c.videos.slice(0, 1)) { try { await enviarMedia(igUsuario, 'video', `${base}/api/foto/${id}`); enviadas++; } catch (e) { fallas++; console.error('video', e); } }
      if (!enviadas) {
        await avisar(`Margaret no pudo mandar las fotos de ${r['Modelo']} a ${cliente || 'un cliente'}. Mandáselas vos por Instagram.`);
        return 'No pude mandar las fotos. Decile al cliente que se las mandás en un momento (Beltrán ya fue avisado).';
      }
      return `Mandé ${enviadas} archivo(s) de ${r['Marca']} ${r['Modelo']}${r['Detalle'] ? ` (${r['Detalle']})` : ''}${fallas ? `; ${fallas} no se pudieron enviar` : ''}.`;
    }
    if (nombre === 'derivar_a_beltran' || nombre === 'no_responder') {
      await avisar(`Margaret derivó a ${cliente || 'un cliente'} de Instagram: ${input.motivo}\n\nLe dijo que seguís vos. Escribile directamente.`);
      await setAhora('margaret', `Derivó a ${cliente || 'un cliente'} con vos.`, 'ok');
      return 'Beltrán ya fue avisado. Contestale al cliente una sola frase corta y humana derivándolo (por ejemplo "Dale querido, ahí te derivo con Beltrán.").';
    }
    if (nombre === 'ver_horarios') {
      const cfg = await configVisitas();
      const dia = new Date(`${input.dia}T12:00:00-03:00`).getUTCDay();
      if (!cfg.dias.includes(dia)) return `Los ${DIAS[dia]} no hay visitas.`;
      const desde = (dia === 2 || dia === 4) ? Math.max(15, cfg.inicio) : cfg.inicio;
      const libres = await huecosDelDia(input.dia, desde, cfg.fin, 60);
      return libres.length ? `Horarios libres el ${DIAS[dia]} ${input.dia}: ${libres.join(', ')} (visitas de una hora).` : `No quedan horarios libres el ${DIAS[dia]} ${input.dia}.`;
    }
    if (nombre === 'proponer_visita') {
      const ini = horaBA(input.inicio);
      if (ini.getTime() < Date.now()) return 'Ese horario ya pasó.';
      const fecha = ini.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
      const quien = input.nombre || cliente || 'Un cliente de Instagram';
      const texto = `Margaret: pedido de visita\n\n${quien} quiere ver ${input.reloj || 'relojes'} el ${fecha} en ${DIRECCION}.`;
      const id = await crearAprobacion('margaret', texto, 'visita', { igUsuario, inicio: input.inicio, reloj: input.reloj || '', cliente: quien });
      const msgId = await enviarConBotones(texto, [{ texto: 'Confirmar visita', dato: `apr:${id}:si` }, { texto: 'Rechazar', dato: `apr:${id}:no` }]);
      if (msgId) await db().from('aprobaciones').update({ telegram_msg_id: msgId }).eq('id', id);
      await setAhora('margaret', `Espera que confirmes una visita: ${quien}.`, 'wait');
      return 'Pedido enviado a Beltrán. Decile al cliente que se la confirmás a la brevedad.';
    }
    if (nombre === 'derivar_oferta') {
      const monto = Number(String(input.detalle).match(/(\d[\d.,]*)\s*(usd|u\$s|dólares|dolares)?/i)?.[1]?.replace(/[.,](?=\d{3}\b)/g, '') || NaN);
      const cuenta = input.reloj && isFinite(monto) ? await analizarOferta(input.reloj, monto).catch(() => null) : null;
      await avisar(`Margaret: oferta para vos\n\n${cliente || 'Un cliente'}${input.reloj ? ` por ${input.reloj}` : ''}: ${input.detalle}${cuenta ? `\n\n${cuenta}` : ''}\n\nRespondele directamente por Instagram.`);
      await setAhora('margaret', `Derivó una oferta${input.reloj ? ` por ${input.reloj}` : ''}.`, 'ok');
      return 'Beltrán ya fue avisado.';
    }
    if (nombre === 'avisar_a_beltran') {
      await avisar(`Margaret necesita un dato\n\n${cliente || 'Un cliente'} en Instagram: ${input.motivo}\n\nRespondele directamente por Instagram, o contale a Arthur la respuesta.`);
      return 'Beltrán ya fue avisado.';
    }
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
  return 'Herramienta desconocida.';
}

export async function responderMargaret(igUsuario: string, idMensaje: number) {
  const base = db();
  // Si el cliente manda varios mensajes seguidos, esperamos y contestamos una sola vez.
  await new Promise((r) => setTimeout(r, 6000));
  const { data: ultimo } = await base.from('ig_mensajes').select('id').eq('ig_usuario', igUsuario).eq('rol', 'user')
    .order('id', { ascending: false }).limit(1).maybeSingle();
  if (ultimo && ultimo.id !== idMensaje) return;

  // Si Beltrán escribió a mano en esta conversación hace poco, Margaret no se mete.
  const { data: pausa } = await base.from('credenciales').select('valor').eq('clave', `ig_pausa_${igUsuario}`).maybeSingle();
  if (pausa?.valor && Number(pausa.valor) > Date.now()) return;

  const { data: previos } = await base.from('ig_mensajes').select('rol, texto').eq('ig_usuario', igUsuario)
    .order('id', { ascending: false }).limit(16);
  const mensajes: Anthropic.MessageParam[] = [];
  for (const m of (previos ?? []).reverse()) {
    const ultimoM = mensajes[mensajes.length - 1];
    if (ultimoM && ultimoM.role === m.rol) ultimoM.content = `${ultimoM.content}\n${m.texto}`;
    else mensajes.push({ role: m.rol as 'user' | 'assistant', content: m.texto });
  }
  while (mensajes.length && mensajes[0].role !== 'user') mensajes.shift();
  if (!mensajes.length || mensajes[mensajes.length - 1].role !== 'user') return;

  const cliente = await nombreDe(igUsuario);
  await setAhora('margaret', `Respondiendo a ${cliente || 'un cliente'} por Instagram.`, 'ok');

  for (let vuelta = 0; vuelta < 6; vuelta++) {
    const r = await anthropic.messages.create({
      model: MODELO, max_tokens: 500, system: sistema(cliente), tools: herramientas, messages: mensajes,
    });
    if (r.stop_reason !== 'tool_use') {
      const texto = r.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (!texto) return;
      const ids = await enviarDM(igUsuario, texto);
      await base.from('ig_mensajes').insert({ ig_usuario: igUsuario, rol: 'assistant', texto, mid: ids[0] || null });
      const { count } = await base.from('aprobaciones').select('id', { count: 'exact', head: true }).eq('agente', 'margaret').eq('estado', 'pendiente');
      if (!count) await setAhora('margaret', `Le respondió a ${cliente || 'un cliente'} por Instagram.`, 'ok');
      return;
    }
    mensajes.push({ role: 'assistant', content: r.content });
    const resultados: Anthropic.ToolResultBlockParam[] = [];
    let silencio = false;
    for (const b of r.content) {
      if (b.type !== 'tool_use') continue;
      const res = await ejecutar(b.name, b.input, igUsuario, cliente);
      if (res === '__SILENCIO__') silencio = true;
      resultados.push({ type: 'tool_result', tool_use_id: b.id, content: res === '__SILENCIO__' ? 'Listo, Beltrán fue avisado.' : res });
    }
    if (silencio) {
      await setAhora('margaret', `Le pasó una consulta a Beltrán.`, 'ok');
      return;
    }
    mensajes.push({ role: 'user', content: resultados });
  }
}
