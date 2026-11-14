import { db, setAhora } from './db';
import { anthropic, fechaBA } from './claude';
import { enviarConBotones, avisar } from './telegram';
import { crearAprobacion } from './aprobaciones';
import { estadoLinkedin } from './linkedin';
import path from 'path';
import { promises as fs } from 'fs';
import { listarDrive, jpegDeDrive } from './google';
import { carpetaRaiz } from './fotos';
import { ffmpeg, carpetaTemporal, bajarDeDrive } from './video';
import { enviarFoto } from './telegram';

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
Imágenes: a veces vas a recibir fotos de la carpeta LinkedIn de Beltrán, cada una con una letra (A, B, C…). Elegí de 0 a 3 que acompañen bien ESTA publicación (que tengan que ver con el tema; si ninguna encaja, ninguna). Escribí el texto coherente con lo que se ve, sin describir la foto de forma obvia.
Devolvé el texto de la publicación, listo para pegar, y en la última línea, sola, "IMAGENES: " seguido de las letras elegidas separadas por coma, o "IMAGENES: ninguna".`;

async function anteriores() {
  const { data } = await db().from('linkedin_posts').select('tema, contenido, estado').order('id', { ascending: false }).limit(12);
  return (data || []).map((p) => `- [${p.estado}] ${p.tema || ''}: ${String(p.contenido).split('\n')[0].slice(0, 100)}`).join('\n') || 'ninguna todavía';
}

// Fotos de la carpeta "LinkedIn" del Drive (las más nuevas que todavía no se publicaron).
async function fotosDisponibles() {
  const raiz = await carpetaRaiz();
  const carpeta = (await listarDrive(`${raiz ? `'${raiz}' in parents and ` : ''}mimeType = 'application/vnd.google-apps.folder' and trashed = false`)).find((f: any) => /linkedin/i.test(f.name));
  if (!carpeta) return [];
  const fotos = await listarDrive(`'${carpeta.id}' in parents and trashed = false and (mimeType = 'image/jpeg' or mimeType = 'image/png' or mimeType = 'image/webp' or mimeType = 'image/heic' or mimeType = 'image/heif')`, 'files(id,name,mimeType,createdTime)');
  const { data: usadas } = await db().from('linkedin_posts').select('imagenes').eq('estado', 'publicado');
  const ya = new Set((usadas || []).flatMap((u: any) => u.imagenes || []));
  return fotos.filter((f: any) => !ya.has(f.id)).sort((a: any, b: any) => String(b.createdTime).localeCompare(String(a.createdTime))).slice(0, 8);
}

// Baja una foto del Drive y la pasa a JPG (LinkedIn y Claude no aceptan HEIC del iPhone).
export async function fotoJpg(id: string, ancho = 2000) {
  const dir = await carpetaTemporal();
  try {
    const orig = await bajarDeDrive(id, path.join(dir, 'orig'));
    const out = path.join(dir, 'foto.jpg');
    try {
      await ffmpeg(['-i', orig, '-frames:v', '1', '-vf', `scale='min(${ancho},iw)':-2`, '-q:v', '3', out]);
      return await fs.readFile(out);
    } catch {
      return await jpegDeDrive(id, ancho);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function escribir(pedido: string, conFotos = true) {
  const fotos = conFotos ? await fotosDisponibles().catch(() => []) : [];
  const bloques: any[] = [];
  const letras = 'ABCDEFGH';
  const vistas: { letra: string; id: string }[] = [];
  for (const [i, f] of fotos.entries()) {
    try {
      const jpg = await fotoJpg(f.id, 800);
      bloques.push({ type: 'text', text: `Imagen ${letras[i]} (${f.name}):` }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpg.toString('base64') } });
      vistas.push({ letra: letras[i], id: f.id });
    } catch { /* si una foto no se puede leer, seguimos */ }
  }
  bloques.push({ type: 'text', text: `Fecha: ${fechaBA()}.\nPublicaciones anteriores (no repitas temas ni ganchos):\n${await anteriores()}\n\n${pedido}${vistas.length ? '' : '\n(No hay fotos disponibles: terminá con "IMAGENES: ninguna".)'}` });
  const r = await anthropic.messages.create({ model: MODELO, max_tokens: 3000, system: SISTEMA, messages: [{ role: 'user', content: bloques }] });
  let t = r.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim().replace(/\*\*/g, '');
  if (!t) throw new Error(`respuesta vacía (${r.stop_reason})`);
  const m = /\n?\s*IM[AÁ]GENES:\s*(.*)\s*$/i.exec(t);
  let imagenes: string[] = [];
  if (m) {
    t = t.slice(0, m.index).trim();
    const elegidas = m[1].toUpperCase().match(/[A-H]/g) || [];
    if (!/ninguna/i.test(m[1])) imagenes = elegidas.map((l) => vistas.find((v) => v.letra === l)?.id).filter(Boolean) as string[];
  }
  return { texto: t, imagenes: imagenes.slice(0, 3) };
}

async function mandarParaAprobar(postId: number, texto: string, encabezado: string, imagenes: string[] = []) {
  for (const [i, id] of imagenes.entries()) {
    const jpg = await fotoJpg(id, 1280).catch(() => null);
    if (jpg) await enviarFoto(jpg, `Oliver — foto ${i + 1} de ${imagenes.length} para la publicación #${postId}`);
  }
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
    const { texto, imagenes } = await escribir([
      input.tema ? `Tema pedido por Beltrán: ${input.tema}.` : 'Elegí vos el tema de esta semana, rotando entre los cuatro ejes.',
      input.notas ? `Indicaciones de Beltrán: ${input.notas}` : '',
    ].filter(Boolean).join('\n'));
    const { data } = await db().from('linkedin_posts').insert({ tema: input.tema || null, contenido: texto, imagenes }).select('id').single();
    await mandarParaAprobar(data!.id, texto, `Oliver — publicación para LinkedIn #${data!.id}${imagenes.length ? ` (con ${imagenes.length} foto${imagenes.length > 1 ? 's' : ''}, arriba)` : ''}`, imagenes);
    await setAhora('oliver', `Publicación #${data!.id} esperando tu aprobación.`, 'wait');
    return data!.id as number;
  } catch (e: any) {
    await setAhora('oliver', 'No pudo escribir la publicación.', 'idle');
    await avisar(`Oliver no pudo escribir la publicación: ${e.message}`);
    throw e;
  }
}

export async function revisarPost(input: { id?: number; cambios: string }) {
  let q = db().from('linkedin_posts').select('id, tema, contenido, imagenes').eq('estado', 'borrador').order('id', { ascending: false }).limit(1);
  if (input.id) q = db().from('linkedin_posts').select('id, tema, contenido, imagenes').eq('id', input.id).limit(1);
  const { data } = await q;
  const p = data?.[0];
  if (!p) return 'No encontré un borrador de LinkedIn para cambiar.';
  await setAhora('oliver', `Reescribiendo la publicación #${p.id}.`, 'ok');
  // Solo vuelve a elegir fotos si Beltrán habla de las fotos; si no, mantiene las que ya tenía.
  const cambiaFotos = /foto|imagen|imágen/i.test(input.cambios);
  const r = await escribir(`Reescribí esta publicación aplicando los cambios que pide Beltrán, manteniendo lo que no menciona.\nCambios: ${input.cambios}\n\nPublicación actual:\n${p.contenido}`, cambiaFotos);
  const texto = r.texto;
  const imagenes = cambiaFotos ? r.imagenes : (p.imagenes || []);
  await db().from('linkedin_posts').update({ contenido: texto, imagenes }).eq('id', p.id);
  // La versión anterior queda sin efecto.
  await db().from('aprobaciones').update({ estado: 'rechazada', resuelta: new Date().toISOString() }).eq('tipo', 'linkedin').eq('estado', 'pendiente').contains('datos', { postId: p.id });
  await mandarParaAprobar(p.id, texto, `Oliver — nueva versión de la publicación #${p.id}`, cambiaFotos ? imagenes : []);
  await setAhora('oliver', `Publicación #${p.id} esperando tu aprobación.`, 'wait');
  return `Oliver mandó la nueva versión de la publicación #${p.id} para aprobar.`;
}
