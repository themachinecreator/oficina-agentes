import { db, setAhora } from './db';
import { responderCorreo, crearEvento, horaBA } from './google';
import { enviarDM } from './instagram';
import { crearContenedor, esperarContenedor, publicarContenedor } from './publicar';
import { editarMensaje } from './telegram';

export async function crearAprobacion(agente: string, texto: string, tipo = 'general', datos: unknown = null) {
  const { data, error } = await db().from('aprobaciones')
    .insert({ agente, texto, tipo, datos }).select('id').single();
  if (error) throw new Error(error.message);
  return data.id as number;
}

// Resuelve una aprobación desde Telegram o desde la oficina. Devuelve el texto para mostrar.
export async function resolverAprobacion(id: number, aprobado: boolean): Promise<string> {
  const base = db();
  const { data: ap } = await base.from('aprobaciones').select('*').eq('id', id).maybeSingle();
  if (!ap) return 'No encontré esa aprobación.';
  if (ap.estado !== 'pendiente') return `Esto ya estaba ${ap.estado}.`;

  let resultado = aprobado ? 'Aprobado.' : 'Rechazado.';
  if (ap.tipo === 'respuesta_mail') {
    const { correo, borrador } = ap.datos || {};
    if (aprobado) {
      try {
        await responderCorreo(correo, borrador);
        await base.from('correos').update({ accion: 'responder', respuesta: borrador }).eq('id', correo.id);
        resultado = `Respuesta enviada a ${correo.de}.`;
      } catch (e: any) {
        return `No pude enviar la respuesta: ${e.message}`;
      }
    } else {
      resultado = `No respondí el mail de ${correo?.de || 'ese remitente'}.`;
    }
  }
  if (ap.tipo === 'reel') {
    const { guionId, url, caption } = ap.datos || {};
    if (aprobado) {
      try {
        await setAhora('theo', `Publicando el reel del guion #${guionId}.`, 'ok');
        const cont = await crearContenedor('REELS', url, true, caption);
        await esperarContenedor(cont, 240000);
        await publicarContenedor(cont);
        await base.from('guiones').update({ estado: 'publicado', actualizado: new Date().toISOString() }).eq('id', guionId);
        await base.from('publicaciones').update({ estado: 'publicada' }).like('archivo', `reels/guion-${guionId}-%`);
        resultado = `Reel del guion #${guionId} publicado en @beltranrelojes.`;
      } catch (e: any) {
        return `No pude publicar el reel: ${e.message}`;
      }
    } else {
      resultado = ap.datos?.musica === 'sin' ? 'Listo, el reel queda para que lo publiques vos con tu audio.' : 'No se publica. Pedile a Arthur los cambios que quieras.';
    }
  }
  if (ap.tipo === 'visita') {
    const { igUsuario, inicio, reloj, cliente } = ap.datos || {};
    const fecha = horaBA(inicio).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    try {
      if (aprobado) {
        const fin = new Date(horaBA(inicio).getTime() - 2 * 3600000).toISOString().slice(0, 16);
        await crearEvento({ titulo: `Visita: ${cliente}${reloj ? ` (${reloj})` : ''}`, inicio, fin, lugar: 'Av. Alvear 1491', descripcion: 'Visita coordinada por Margaret por Instagram.' });
        const texto = `Querido, te confirmo la visita para el ${fecha} en Av. Alvear 1491. ¡Te esperamos!`;
        const ids = await enviarDM(igUsuario, texto);
        await base.from('ig_mensajes').insert({ ig_usuario: igUsuario, rol: 'assistant', texto, mid: ids[0] || null });
        resultado = `Visita confirmada y agendada: ${cliente}, ${fecha}.`;
      } else {
        const texto = 'Querido, lamentablemente ese horario no va a poder ser. ¿Te sirve otro día u horario? Así lo coordinamos.';
        const ids = await enviarDM(igUsuario, texto);
        await base.from('ig_mensajes').insert({ ig_usuario: igUsuario, rol: 'assistant', texto, mid: ids[0] || null });
        resultado = `Le avisé a ${cliente} que busque otro horario.`;
      }
    } catch (e: any) {
      return `No pude completar la visita: ${e.message}`;
    }
  }
  await base.from('aprobaciones')
    .update({ estado: aprobado ? 'aprobada' : 'rechazada', resuelta: new Date().toISOString() }).eq('id', id);

  const { count } = await base.from('aprobaciones').select('id', { count: 'exact', head: true })
    .eq('agente', ap.agente).eq('estado', 'pendiente');
  await setAhora(ap.agente, count ? `${count} ${count === 1 ? 'tema espera' : 'temas esperan'} tu aprobación.` : resultado, count ? 'wait' : 'ok');

  if (ap.telegram_msg_id) await editarMensaje(ap.telegram_msg_id, `${ap.texto}\n\n— ${resultado}`);
  return resultado;
}
