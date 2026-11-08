import { db, setAhora } from './db';
import { responderCorreo } from './google';
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
  await base.from('aprobaciones')
    .update({ estado: aprobado ? 'aprobada' : 'rechazada', resuelta: new Date().toISOString() }).eq('id', id);

  const { count } = await base.from('aprobaciones').select('id', { count: 'exact', head: true })
    .eq('agente', ap.agente).eq('estado', 'pendiente');
  await setAhora(ap.agente, count ? `${count} ${count === 1 ? 'tema espera' : 'temas esperan'} tu aprobación.` : resultado, count ? 'wait' : 'ok');

  if (ap.telegram_msg_id) await editarMensaje(ap.telegram_msg_id, `${ap.texto}\n\n— ${resultado}`);
  return resultado;
}
