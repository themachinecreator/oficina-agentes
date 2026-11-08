import { db, AGENTES_IDS, setAhora, AgenteId } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { agente, descripcion } = await req.json();
  if (!AGENTES_IDS.includes(agente) || typeof descripcion !== 'string' || !descripcion.trim()) {
    return Response.json({ error: 'Falta el agente o la descripción.' }, { status: 400 });
  }
  const { error } = await db().from('tareas').insert({ agente, descripcion: descripcion.trim().slice(0, 500), origen: 'oficina' });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  await setAhora(agente as AgenteId, `Tarea en cola: ${descripcion.trim().slice(0, 120)}`);
  return Response.json({ ok: true });
}
