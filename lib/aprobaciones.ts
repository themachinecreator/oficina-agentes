import { db, setAhora } from './db';
import { enviarCorreo, responderCorreo, crearEvento, horaBA } from './google';
import { enviarDM } from './instagram';
import { crearContenedor, esperarContenedor, publicarContenedor } from './publicar';
import { editarMensaje } from './telegram';
import { lanzarCampana } from './marketing';

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
  if (ap.tipo === 'mail_nuevo') {
    const { para, asunto, cuerpo } = ap.datos || {};
    if (aprobado) {
      try {
        await enviarCorreo(para, asunto, cuerpo);
        await setAhora('eleanor', `Mandó un mail a ${para}.`, 'ok');
        resultado = `Mail enviado a ${para}.`;
      } catch (e: any) {
        return `No pude enviar el mail: ${e.message}`;
      }
    } else {
      resultado = 'No mandé el mail.';
    }
  }
  if (ap.tipo === 'reel') {
    const { guionId, url, caption } = ap.datos || {};
    if (aprobado) {
      try {
        await setAhora('theo', guionId ? `Publicando el reel del guion #${guionId}.` : 'Publicando el reel.', 'ok');
        const cont = await crearContenedor('REELS', url, true, caption);
        await esperarContenedor(cont, 240000);
        await publicarContenedor(cont);
        if (guionId) {
          await base.from('guiones').update({ estado: 'publicado', actualizado: new Date().toISOString() }).eq('id', guionId);
          await base.from('publicaciones').update({ estado: 'publicada' }).like('archivo', `reels/guion-${guionId}-%`);
        }
        resultado = guionId ? `Reel del guion #${guionId} publicado en @beltranrelojes.` : 'Reel publicado en @beltranrelojes.';
      } catch (e: any) {
        return `No pude publicar el reel: ${e.message}`;
      }
    } else {
      resultado = ap.datos?.musica === 'sin' ? 'Listo, el video queda para que lo publiques vos desde Instagram (bajalo del link).' : 'No se publica. Pedile a Arthur los cambios que quieras.';
    }
  }
  if (ap.tipo === 'campana') {
    const { campanaId, manual } = ap.datos || {};
    if (aprobado && manual) {
      const { data: k } = await base.from('campanas').select('dias').eq('id', campanaId).maybeSingle();
      const inicio = new Date();
      await base.from('campanas').update({ estado: 'activa', inicio: inicio.toISOString(), fin: new Date(inicio.getTime() + Number(k?.dias || 7) * 86400000).toISOString() }).eq('id', campanaId);
      await setAhora('victoria', `Siguiendo el anuncio #${campanaId}.`, 'ok');
      resultado = `Anotado: anuncio #${campanaId} en marcha. Victoria va a mirar cómo rinde la publicación en su informe.`;
    } else if (aprobado) {
      try {
        await setAhora('victoria', `Lanzando el anuncio #${campanaId}.`, 'ok');
        resultado = await lanzarCampana(campanaId);
      } catch (e: any) {
        await setAhora('victoria', `No pudo lanzar el anuncio #${campanaId}.`, 'idle');
        return `No pude lanzar el anuncio: ${e.message}`;
      }
    } else {
      await base.from('campanas').update({ estado: 'rechazada' }).eq('id', campanaId);
      resultado = `Anuncio #${campanaId} descartado.`;
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
