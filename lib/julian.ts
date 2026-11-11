import { db, setAhora } from './db';
import { anthropic, fechaBA } from './claude';
import { stockDisponible } from './stock';
import { enviar } from './telegram';

// Julian escribe más y mejor que el resto: usa un modelo más capaz (pocos pedidos por semana, costo bajo).
const MODELO_JULIAN = process.env.JULIAN_MODEL || 'claude-sonnet-5-5';
const IG_ID = process.env.INSTAGRAM_ACCOUNT_ID || '17841447907774982';

// Qué funcionó en la cuenta: últimos posteos con su interacción.
async function rendimientoCuenta() {
  try {
    const { data } = await db().from('credenciales').select('valor').eq('clave', 'instagram_token').maybeSingle();
    if (!data?.valor) return '';
    const r = await fetch(`https://graph.facebook.com/v23.0/${IG_ID}/media?limit=30&fields=caption,media_type,timestamp,like_count,comments_count`, {
      headers: { Authorization: `Bearer ${data.valor}` },
    });
    const d = await r.json();
    const posts = (d.data || []).filter((p: any) => p.caption).map((p: any) => ({
      texto: String(p.caption).split('\n')[0].slice(0, 80), tipo: p.media_type, likes: p.like_count || 0, comentarios: p.comments_count || 0,
    }));
    posts.sort((a: any, b: any) => (b.likes + 3 * b.comentarios) - (a.likes + 3 * a.comentarios));
    return posts.slice(0, 12).map((p: any) => `- "${p.texto}" (${p.tipo === 'VIDEO' ? 'reel' : 'post'}): ${p.likes} likes, ${p.comentarios} comentarios`).join('\n');
  } catch { return ''; }
}

async function contexto() {
  const [rend, stock, previos] = await Promise.all([
    rendimientoCuenta(),
    stockDisponible().catch(() => []),
    db().from('guiones').select('titulo, estado, creado').order('creado', { ascending: false }).limit(25),
  ]);
  const enStock = stock.map((r) => `${r['Marca']} ${r['Modelo']}${r['Referencia'] ? ` ref. ${r['Referencia']}` : ''}${r['Detalle'] ? ` (${r['Detalle']})` : ''}`).join('; ');
  return `Fecha: ${fechaBA()}.
Relojes en stock (podés destacarlos de vez en cuando, sin que todo sea venta): ${enStock || 'sin datos'}.
Posteos de la cuenta con más interacción (likes + comentarios):
${rend || 'sin datos'}
Guiones ya propuestos (no repitas temas):
${(previos.data || []).map((g) => `- ${g.titulo} [${g.estado}]`).join('\n') || 'ninguno todavía'}`;
}

const SISTEMA = `Sos Julian Hart, creador de contenido y director creativo de beltranrelojes, la cuenta de Instagram del negocio de relojes de Beltrán (unos 3.200 seguidores, Argentina). Curioso y apasionado por la historia relojera.

Lo que funciona en la cuenta: videos cortos de historia de marcas y modelos ("La dinastía Tudor"), datos curiosos con pregunta al público ("¿Ustedes lo sabían? Citizen Bullhead") y piezas históricas. El dato con pregunta es lo que más comentarios genera. Textos de publicación cortos. Beltrán quiere mantener eso y también innovar con formatos nuevos.

Beltrán graba exactamente lo que le indicás y después Theo, el editor, arma el video. Por eso tu guion tiene que ser concreto y grabable con un celular: qué se ve en cada toma, qué se dice, qué texto va en pantalla.

Reglas:
- Español rioplatense, con voseo, tono culto pero cercano. Sin markdown, sin asteriscos ni numerales: es para Telegram.
- Datos históricos y técnicos correctos. Si no estás seguro de un dato (fecha, cifra, calibre), no lo uses o marcalo con "(verificar)".
- Los primeros 2 segundos tienen que enganchar: una pregunta, una afirmación sorprendente o una imagen fuerte.
- Duración por defecto: entre 30 y 60 segundos.
- Nunca menciones costos, ganancias ni precios de compra del negocio.`;

const FORMATO_GUION = `Escribí el guion con estas secciones, en este orden y con estos títulos en mayúsculas:
TÍTULO: (corto, para identificarlo)
IDEA: (una línea: de qué va y por qué funciona)
GANCHO: (lo que se ve y se dice en los primeros 2 segundos)
GUION: tomas numeradas. Para cada una: duración aproximada, qué se ve (plano y acción), qué se dice (voz o a cámara) y texto en pantalla si va.
QUÉ GRABAR: lista de tomas para que Beltrán grabe de corrido, con indicaciones prácticas (luz, ángulo, fondo, qué reloj).
PARA THEO: ritmo de cortes, música sugerida (estilo, no canciones con nombre), subtítulos, transiciones y cierre.
TEXTO DE LA PUBLICACIÓN: corto, con la pregunta al público si aplica.
HASHTAGS: entre 6 y 10, mezclando español e inglés.
PORTADA: qué imagen y qué texto.`;

async function generar(pedido: string, maxTokens = 2500) {
  const r = await anthropic.messages.create({
    model: MODELO_JULIAN,
    max_tokens: maxTokens,
    system: `${SISTEMA}\n\n${await contexto()}`,
    messages: [{ role: 'user', content: pedido }],
  });
  return r.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
}

const tituloDe = (texto: string) => (texto.match(/T[IÍ]TULO:\s*(.+)/i)?.[1] || texto.split('\n')[0]).trim().slice(0, 120);

export async function pedirGuion(input: { tema?: string; formato?: string; notas?: string }, chatId?: number | string) {
  await setAhora('julian', input.tema ? `Escribiendo un guion: ${input.tema}.` : 'Pensando el próximo guion.', 'ok');
  const pedido = [
    input.tema ? `Tema: ${input.tema}.` : 'Elegí vos el tema: algo que encaje con lo que funciona en la cuenta o un formato nuevo que valga la pena probar.',
    input.formato ? `Formato pedido: ${input.formato}.` : '',
    input.notas ? `Indicaciones de Beltrán: ${input.notas}.` : '',
    FORMATO_GUION,
  ].filter(Boolean).join('\n');
  const guion = await generar(pedido);
  const { data } = await db().from('guiones').insert({ titulo: tituloDe(guion), formato: input.formato || null, contenido: guion }).select('id').single();
  if (chatId) await enviar(chatId, `Julian — guion #${data?.id}\n\n${guion}`);
  await setAhora('julian', `Entregó el guion #${data?.id}: ${tituloDe(guion)}.`, 'ok');
  return { id: data?.id, titulo: tituloDe(guion) };
}

export async function pedirIdeas(input: { cantidad?: number; enfoque?: string }, chatId?: number | string) {
  await setAhora('julian', 'Armando ideas de contenido.', 'ok');
  const n = Math.min(Math.max(input.cantidad || 5, 3), 10);
  const ideas = await generar(
    `Actuá como director creativo. Proponé ${n} ideas de videos para las próximas semanas${input.enfoque ? `, con este enfoque: ${input.enfoque}` : ''}. ` +
    'Mezclá lo que ya funciona con al menos dos formatos nuevos (series, desafíos, comparaciones, mitos, detrás de escena, preguntas del público). ' +
    'Para cada idea: título, formato, el gancho en una línea y por qué puede funcionar. Numeralas con "Idea 1", "Idea 2", etc. Al final, sugerí un orden de publicación para la semana.',
    1800,
  );
  if (chatId) await enviar(chatId, `Julian — ideas\n\n${ideas}`);
  await setAhora('julian', `Propuso ${n} ideas de contenido.`, 'ok');
  return ideas;
}

export async function revisarGuion(input: { id: number; cambios: string }, chatId?: number | string) {
  const { data: g } = await db().from('guiones').select('id, contenido').eq('id', input.id).maybeSingle();
  if (!g) return `No encontré el guion #${input.id}.`;
  await setAhora('julian', `Ajustando el guion #${g.id}.`, 'ok');
  const nuevo = await generar(`Este es un guion tuyo:\n\n${g.contenido}\n\nBeltrán pide estos cambios: ${input.cambios}\n\nDevolvé el guion completo corregido, con las mismas secciones.\n${FORMATO_GUION}`);
  await db().from('guiones').update({ contenido: nuevo, titulo: tituloDe(nuevo), actualizado: new Date().toISOString() }).eq('id', g.id);
  if (chatId) await enviar(chatId, `Julian — guion #${g.id} corregido\n\n${nuevo}`);
  await setAhora('julian', `Corrigió el guion #${g.id}.`, 'ok');
  return `Guion #${g.id} corregido y enviado.`;
}

export async function marcarGuion(id: number, estado: string) {
  const { error } = await db().from('guiones').update({ estado, actualizado: new Date().toISOString() }).eq('id', id);
  return error ? `Error: ${error.message}` : `Guion #${id} marcado como ${estado}.`;
}

export async function listarGuiones() {
  const { data } = await db().from('guiones').select('id, titulo, estado').in('estado', ['propuesto', 'grabado', 'editado']).order('creado', { ascending: false }).limit(15);
  return (data || []).map((g) => `#${g.id} · ${g.estado} · ${g.titulo}`).join('\n') || 'No hay guiones pendientes.';
}
