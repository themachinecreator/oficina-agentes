import { db, setAhora } from './db';
import { anthropic, fechaBA } from './claude';
import { enviarConBotones, avisar } from './telegram';
import { crearAprobacion } from './aprobaciones';
import { estadoLinkedin } from './linkedin';

// Oliver Pemberton: la marca personal de Beltrán en LinkedIn. Propone una publicación por semana; nada sale sin aprobación.
const MODELO = process.env.OLIVER_MODEL || process.env.JULIAN_MODEL || 'claude-sonnet-5-5';

const SISTEMA = `Sos Oliver Pemberton, a cargo de la marca personal de Beltrán Symonds Dagnino en LinkedIn. Escribís publicaciones en su nombre, en primera persona.
Quién es Beltrán (usá solo esto, no inventes logros, cifras, empresas ni cargos):
- Estudia Negocios Digitales en la Universidad de San Andrés (UdeSA), Buenos Aires.
- Tiene un emprendimiento de compraventa de relojes vintage y de lujo (Beltrán Relojes, @beltranrelojes en Instagram), con atención por Instagram y visitas con cita.
- Está desarrollando un marketplace de relojes en Argentina estilo Chrono24 (reloje.ar).
- Desarrolla y publica apps móviles.
- Armó una "oficina" de agentes de IA que lo ayudan con el negocio: una secretaria que maneja su mail y agenda, atención al cliente por Instagram, un contador, un guionista, un editor de video que publica historias solo y una estratega de marketing.
- Le interesan la política y las políticas públicas: redacta proyectos de ley propios.
- Lleva adelante Joiner (joinerwork.com), su proyecto para conectar talento con empresas: las personas se suman desde la app (iOS y Android) o la web, completan su perfil con sus habilidades y su CV, y el equipo de Joiner las presenta a empresas según lo que cada una busca.
Temas: emprendimiento y relojes (lo que aprende comprando y vendiendo, el mercado, historias de marcas desde el lado negocio), tecnología e IA (sus agentes, automatización, apps), Joiner, carrera y facultad, y política y proyectos de ley. Rotá los cinco temas y no repitas los ya publicados.
Cuando el tema sea Joiner: el objetivo es sumar talentos. Hablale a estudiantes y profesionales (sobre todo jóvenes) sobre conseguir oportunidades reales a partir de lo que saben hacer, y cerrá invitando a sumarse en joinerwork.com o descargando la app Joiner. Presentá Joiner siempre como un proyecto propio de Beltrán: nunca digas que lo compró, heredó o que viene de otra app, ni hables de cuánto creció, de usuarios, de tracción o de cambios de rumbo; tampoco menciones precios ni planes pagos.
Tono: profesional cercano. Primera persona, historias concretas y aprendizajes reales. Nada de frases de gurú, listas de "10 consejos", promesas ni autobombo. Pocos emojis (cero a dos) y nada de markdown ni asteriscos.
Forma:
- Primera línea que enganche por sí sola (es lo único que se ve antes del "ver más").
- Párrafos de una a tres líneas, separados por una línea en blanco.
- Entre 120 y 220 palabras.
- Cerrá con una pregunta o una reflexión que invite a comentar.
- Al final, de 2 a 4 hashtags relevantes.
Cuidados:
- Nunca menciones costos, márgenes, ventas en negro, impuestos ni datos de clientes.
- Si el tema es político, exponé la idea con argumentos y respeto, sin atacar a personas ni partidos.
- Si no estás seguro de un dato, no lo uses.
Devolvé SOLO el texto de la publicación, listo para pegar.`;

async function anteriores() {
  const { data } = await db().from('linkedin_posts').select('tema, contenido, estado').order('id', { ascending: false }).limit(12);
  return (data || []).map((p) => `- [${p.estado}] ${p.tema || ''}: ${String(p.contenido).split('\n')[0].slice(0, 100)}`).join('\n') || 'ninguna todavía';
}

async function escribir(pedido: string) {
  const r = await anthropic.messages.create({
    model: MODELO, max_tokens: 3000, system: SISTEMA,
    messages: [{ role: 'user', content: `Fecha: ${fechaBA()}.\nPublicaciones anteriores (no repitas temas ni ganchos):\n${await anteriores()}\n\n${pedido}` }],
  });
  const t = r.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim().replace(/\*\*/g, '');
  if (!t) throw new Error(`respuesta vacía (${r.stop_reason})`);
  return t;
}

async function mandarParaAprobar(postId: number, texto: string, encabezado: string) {
  const { conectado, dias } = await estadoLinkedin();
  const aviso = !conectado ? '\n\n(LinkedIn todavía no está conectado: si tocás Publicar te aviso cómo conectarlo.)' : dias < 7 ? `\n\n(La conexión con LinkedIn vence en ${dias} días: reconectá en /api/linkedin/conectar.)` : '';
  const msj = `${encabezado}\n\n${texto}${aviso}\n\nSi querés cambios, decile a Arthur qué cambiar y Oliver lo reescribe.`;
  const id = await crearAprobacion('oliver', msj, 'linkedin', { postId });
  const m = await enviarConBotones(msj, [{ texto: 'Publicar', dato: `apr:${id}:si` }, { texto: 'No publicar', dato: `apr:${id}:no` }]);
  if (m) await db().from('aprobaciones').update({ telegram_msg_id: m }).eq('id', id);
}

export async function proponerPost(input: { tema?: string; notas?: string } = {}) {
  await setAhora('oliver', input.tema ? `Escribiendo para LinkedIn: ${input.tema}.` : 'Pensando la publicación de LinkedIn de la semana.', 'ok');
  try {
    const texto = await escribir([
      input.tema ? `Tema pedido por Beltrán: ${input.tema}.` : 'Elegí vos el tema de esta semana, rotando entre los cuatro ejes.',
      input.notas ? `Indicaciones de Beltrán: ${input.notas}` : '',
    ].filter(Boolean).join('\n'));
    const { data } = await db().from('linkedin_posts').insert({ tema: input.tema || null, contenido: texto }).select('id').single();
    await mandarParaAprobar(data!.id, texto, `Oliver — publicación para LinkedIn #${data!.id}`);
    await setAhora('oliver', `Publicación #${data!.id} esperando tu aprobación.`, 'wait');
    return data!.id as number;
  } catch (e: any) {
    await setAhora('oliver', 'No pudo escribir la publicación.', 'idle');
    await avisar(`Oliver no pudo escribir la publicación: ${e.message}`);
    throw e;
  }
}

export async function revisarPost(input: { id?: number; cambios: string }) {
  let q = db().from('linkedin_posts').select('id, tema, contenido').eq('estado', 'borrador').order('id', { ascending: false }).limit(1);
  if (input.id) q = db().from('linkedin_posts').select('id, tema, contenido').eq('id', input.id).limit(1);
  const { data } = await q;
  const p = data?.[0];
  if (!p) return 'No encontré un borrador de LinkedIn para cambiar.';
  await setAhora('oliver', `Reescribiendo la publicación #${p.id}.`, 'ok');
  const texto = await escribir(`Reescribí esta publicación aplicando los cambios que pide Beltrán, manteniendo lo que no menciona.\nCambios: ${input.cambios}\n\nPublicación actual:\n${p.contenido}`);
  await db().from('linkedin_posts').update({ contenido: texto }).eq('id', p.id);
  // La versión anterior queda sin efecto.
  await db().from('aprobaciones').update({ estado: 'rechazada', resuelta: new Date().toISOString() }).eq('tipo', 'linkedin').eq('estado', 'pendiente').contains('datos', { postId: p.id });
  await mandarParaAprobar(p.id, texto, `Oliver — nueva versión de la publicación #${p.id}`);
  await setAhora('oliver', `Publicación #${p.id} esperando tu aprobación.`, 'wait');
  return `Oliver mandó la nueva versión de la publicación #${p.id} para aprobar.`;
}
