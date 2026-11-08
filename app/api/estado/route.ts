import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const base = db();
  const [agentes, tareas, aprobaciones] = await Promise.all([
    base.from('agentes').select('id, estado, ahora, activo'),
    base.from('tareas').select('id, agente, descripcion, estado, creada').order('creada', { ascending: false }).limit(60),
    base.from('aprobaciones').select('id, agente, texto').eq('estado', 'pendiente').order('creada'),
  ]);
  if (agentes.error) return Response.json({ error: agentes.error.message }, { status: 500 });
  const hora = (iso: string) => new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  return Response.json({
    agentes: agentes.data.map((a) => ({
      ...a,
      tareas: (tareas.data ?? []).filter((t) => t.agente === a.id).slice(0, 6)
        .map((t) => ({ id: t.id, hora: t.estado === 'pendiente' ? 'En cola' : hora(t.creada), descripcion: t.descripcion, estado: t.estado })),
    })),
    aprobaciones: aprobaciones.data ?? [],
  });
}
