import { after } from 'next/server';
import { cronAutorizado } from '@/lib/cron';
import { trabajarVictoria, PEDIDO_SEMANAL } from '@/lib/victoria';
import { registrarMetricas } from '@/lib/marketing';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// ?accion=metricas (todas las noches), ?accion=semanal (lunes) o POST { pedido } desde Arthur.
async function correr(req: Request) {
  if (!cronAutorizado(req)) return Response.json({ error: 'No autorizado' }, { status: 401 });
  const accion = new URL(req.url).searchParams.get('accion');
  if (accion === 'metricas') return Response.json({ ok: true, seguidores: await registrarMetricas() });
  const cuerpo = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const pedido = accion === 'semanal' ? PEDIDO_SEMANAL : cuerpo.pedido;
  if (!pedido) return Response.json({ error: 'Falta el pedido.' }, { status: 400 });
  after(() => trabajarVictoria(String(pedido)).catch(() => {}));
  return Response.json({ ok: true });
}
export const GET = correr;
export const POST = correr;
