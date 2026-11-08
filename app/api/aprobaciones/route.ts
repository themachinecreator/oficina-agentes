import { resolverAprobacion } from '@/lib/aprobaciones';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: Request) {
  const { id, aprobado } = await req.json();
  if (typeof id !== 'number') return Response.json({ error: 'Falta el id.' }, { status: 400 });
  const mensaje = await resolverAprobacion(id, !!aprobado);
  return Response.json({ ok: true, mensaje });
}
