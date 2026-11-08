import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { id, aprobado } = await req.json();
  if (typeof id !== 'number') return Response.json({ error: 'Falta el id.' }, { status: 400 });
  const { error } = await db().from('aprobaciones')
    .update({ estado: aprobado ? 'aprobada' : 'rechazada', resuelta: new Date().toISOString() })
    .eq('id', id).eq('estado', 'pendiente');
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
