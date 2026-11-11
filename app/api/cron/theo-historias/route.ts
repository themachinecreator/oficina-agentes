import { after } from 'next/server';
import { cronAutorizado } from '@/lib/cron';
import { googleConectado } from '@/lib/google';
import { publicarHistoriaDe, relojesParaHistorias, setAhora } from '@/lib/theo';
import { avisar } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Cada dos días: una historia por reloj con fotos o videos. Cada llamada procesa un reloj (i) y encadena el siguiente.
async function correr(req: Request) {
  if (!cronAutorizado(req)) return Response.json({ error: 'No autorizado' }, { status: 401 });
  if (!(await googleConectado())) return Response.json({ ok: true, mensaje: 'Google no está conectado.' });
  const url = new URL(req.url);
  const i = Number(url.searchParams.get('i') || 0);
  const prueba = url.searchParams.get('prueba') === '1';
  const relojes = await relojesParaHistorias();
  if (i >= relojes.length) return Response.json({ ok: true, fin: true });
  const r = relojes[i];
  const nombre = `${r['Marca']} ${r['Modelo']}`;
  await setAhora('theo', `Armando la historia de ${nombre} (${i + 1} de ${relojes.length}).`, 'ok');
  let resultado: any = null;
  try {
    resultado = await publicarHistoriaDe(r, !prueba);
    if (prueba) await avisar(`Theo — historia de prueba (no publicada)\n${nombre}\n${resultado.url}`);
  } catch (e: any) {
    await avisar(`Theo no pudo armar la historia de ${nombre}: ${e.message}`);
  }
  if (i + 1 < relojes.length) {
    const siguiente = new URL(req.url); siguiente.searchParams.set('i', String(i + 1));
    after(() => fetch(siguiente, { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET || '' } }).catch(() => {}));
  } else {
    await setAhora('theo', prueba ? 'Terminó las historias de prueba.' : `Publicó las historias del stock (${relojes.length}).`, 'ok');
    if (!prueba) await avisar(`Theo publicó las historias del stock de hoy (${relojes.length} relojes).`);
  }
  return Response.json({ ok: true, i, reloj: nombre, url: resultado?.url, publicado: !!resultado?.id });
}
export const GET = correr;
export const POST = correr;
