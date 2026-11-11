import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const base = db();
  const [agentes, tareas, aprobaciones, correos] = await Promise.all([
    base.from('agentes').select('id, estado, ahora, activo').neq('ahora', 'Fuera del equipo.'),
    base.from('tareas').select('id, agente, descripcion, estado, creada').order('creada', { ascending: false }).limit(60),
    base.from('aprobaciones').select('id, agente, texto').eq('estado', 'pendiente').order('creada'),
    base.from('correos').select('de, asunto, accion, creado').neq('accion', 'ignorar').order('creado', { ascending: false }).limit(6),
  ]);
  const verbo: Record<string, string> = { responder: 'Respondió', informar: 'Leyó', consultar: 'Te consultó', error: 'No pudo procesar' };
  if (agentes.error) return Response.json({ error: agentes.error.message }, { status: 500 });
  const hora = (iso: string) => new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  return Response.json({
    agentes: agentes.data.map((a) => ({
      ...a,
      tareas: [
        ...(a.id === 'eleanor' ? (correos.data ?? []).map((c) => ({ id: 0, hora: hora(c.creado), descripcion: `${verbo[c.accion] || 'Revisó'}: ${(c.de || '').split('<')[0].replace(/"/g, '').trim()} — ${c.asunto}`, estado: 'hecha' })) : []),
        ...(tareas.data ?? []).filter((t) => t.agente === a.id).slice(0, 6)
          .map((t) => ({ id: t.id, hora: t.estado === 'pendiente' ? 'En cola' : hora(t.creada), descripcion: t.descripcion, estado: t.estado })),
      ].slice(0, 8),
    })),
    aprobaciones: aprobaciones.data ?? [],
  });
}
