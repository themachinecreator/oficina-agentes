import { after } from 'next/server';
import { cronAutorizado } from '@/lib/cron';
import { db } from '@/lib/db';
import { responderMargaret } from '@/lib/margaret';
import { beltranEscribio } from '@/lib/instagram';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Corre cada minuto. Margaret contesta un mensaje de Instagram solo si pasaron unos minutos sin que Beltrán
// conteste a mano. Si Beltrán ya está hablando con ese cliente, no manda nada y se corre de esa charla 12 h.
async function correr(req: Request) {
  if (!cronAutorizado(req)) return Response.json({ error: 'No autorizado' }, { status: 401 });
  const base = db();
  const { data: conf } = await base.from('credenciales').select('valor').eq('clave', 'margaret_espera_min').maybeSingle();
  const espera = Math.max(1, Number(conf?.valor) || 5) * 60000;
  const ahora = Date.now();

  // Clientes con mensajes de las últimas 3 horas.
  const { data: recientes } = await base.from('ig_mensajes').select('id, ig_usuario, rol, creado')
    .like('ig_usuario', 'sp_%').gte('creado', new Date(ahora - 3 * 3600000).toISOString()).order('id', { ascending: true });
  const porCliente = new Map<string, { id: number; rol: string; creado: string }[]>();
  for (const m of recientes || []) {
    const l = porCliente.get(m.ig_usuario) || [];
    l.push(m);
    porCliente.set(m.ig_usuario, l);
  }

  const listos: { cliente: string; id: number; desde: number }[] = [];
  for (const [cliente, msgs] of porCliente) {
    const ultimo = msgs[msgs.length - 1];
    if (ultimo.rol !== 'user' || ahora - Date.parse(ultimo.creado) < espera) continue;
    const { data: visto } = await base.from('credenciales').select('valor').eq('clave', `ig_visto_${cliente}`).maybeSingle();
    if (Number(visto?.valor) >= ultimo.id) continue;
    // Primer mensaje del cliente sin respuesta (desde ahí miramos si Beltrán escribió).
    let i = msgs.length - 1;
    while (i > 0 && msgs[i - 1].rol === 'user') i--;
    listos.push({ cliente, id: ultimo.id, desde: Date.parse(msgs[i].creado) - 60000 });
  }
  for (const l of listos) {
    await base.from('credenciales').upsert({ clave: `ig_visto_${l.cliente}`, valor: String(l.id), actualizado: new Date().toISOString() });
  }

  after(async () => {
    for (const l of listos) {
      try {
        const { data: pausa } = await base.from('credenciales').select('valor').eq('clave', `ig_pausa_${l.cliente}`).maybeSingle();
        if (pausa?.valor && Number(pausa.valor) > Date.now()) continue;
        // Si Beltrán contestó a mano en las últimas 12 h, está en la charla: Margaret se corre.
        const escribio = await beltranEscribio(l.cliente, Math.min(l.desde, Date.now() - 12 * 3600000)).catch(() => false);
        if (escribio) {
          await base.from('credenciales').upsert({ clave: `ig_pausa_${l.cliente}`, valor: String(Date.now() + 12 * 3600000), actualizado: new Date().toISOString() });
          continue;
        }
        await responderMargaret(l.cliente, l.id, { sinEspera: true });
      } catch (e) { console.error('Margaret (cron)', e); }
    }
  });
  return Response.json({ ok: true, pendientes: listos.length });
}
export const GET = correr;
export const POST = correr;
