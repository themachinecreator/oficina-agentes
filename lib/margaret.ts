import Anthropic from '@anthropic-ai/sdk';
import { db, setAhora } from './db';
import { anthropic, MODELO, fechaBA } from './claude';
import { stockDisponible, stockComoTexto } from './stock';
import { huecosDelDia, horaBA } from './google';
import { enviarDM, nombreDe } from './instagram';
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

Tono: formal, cálido y cercano, en español rioplatense con voseo. Saludás según la hora ("Buen día", "Buenas tardes", "Buenas noches") y tratás al cliente de "querido" (o "querida" si es evidente). Por ejemplo, para una consulta general: "Buenas tardes querido, ¿cómo estás? Te dejo toda la información del reloj abajo." Para una pregunta puntual: "Querido, ¿cómo estás? El reloj tiene una caja de 34 mm." Son ejemplos del estilo, no frases para copiar. Mensajes cortos, sin markdown ni asteriscos; podés usar saltos de línea para listar los datos del reloj.

Cómo trabajás:
- Para cualquier pregunta sobre relojes, usá ver_stock y respondé solo con lo que figura ahí. El stock tiene muchas piezas: si el cliente pregunta en general ("¿qué tenés?"), no le mandes la lista entera; preguntale qué busca (marca, presupuesto, estilo, tamaño) o sugerí entre 3 y 5 opciones variadas, y ofrecé contarle más.
- Si una pieza tiene "Precio con descuento", ese es el precio actual: decilo así, mencionando el precio de lista y el descuento (por ejemplo: "está a 350 USD, con un 10% de descuento sobre los 390 de lista"). Si no tiene, el precio es el de lista.
- Una misma pieza puede figurar dos veces (en la colección y en la página). Si dos piezas tienen la misma marca, modelo y precio, tratala como una sola.
- Si hay dos piezas iguales con distinto precio, usá el campo Detalle para explicar la diferencia. Si no hay detalle, decí que se lo consultás a Beltrán.
- Si te preguntan por un reloj que no está, decí que en este momento no lo tenés y ofrecé lo que sí hay si es parecido.
- Si un dato no está en el stock, no lo inventes: decí que lo consultás con Beltrán y usá avisar_a_beltran.
- Precios: solo el precio publicado. Si figura "a consultar", decí que se lo consultás a Beltrán y usá avisar_a_beltran.
- Ofertas o pedidos de descuento, permutas, formas de pago o cuotas especiales: respondé que eso se tiene que hablar directamente con Beltrán, que lo derivás y que él se va a comunicar. Usá derivar_oferta.
- Visitas para ver relojes: son en ${DIRECCION}. Para proponer horarios usá ver_horarios; no ofrezcas horarios que la herramienta no devuelva. Cuando el cliente elija día y hora, usá proponer_visita y decile que se la confirmás a la brevedad. Nunca confirmes una visita vos.
- La página web es beltranrelojes.site: podés pasarla para que vean fotos y el catálogo. Si preguntan por compras por cantidad o precios mayoristas, pasales la página y usá avisar_a_beltran para que él los contacte.
- Nunca hables de costos, márgenes, ganancias, inversión ni de cuánto pagó Beltrán por un reloj.
- No prometas envíos, garantías, autenticaciones ni plazos que no figuren en el stock: consultalo con Beltrán.
- Si el cliente escribe algo que no tiene que ver con relojes, respondé con amabilidad y breve.`;
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
      model: MODELO, max_tokens: 900, system: sistema(cliente), tools: herramientas, messages: mensajes,
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
    for (const b of r.content) {
      if (b.type === 'tool_use') resultados.push({ type: 'tool_result', tool_use_id: b.id, content: await ejecutar(b.name, b.input, igUsuario, cliente) });
    }
    mensajes.push({ role: 'user', content: resultados });
  }
}
