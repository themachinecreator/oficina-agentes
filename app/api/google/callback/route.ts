import { canjearCodigo } from '@/lib/google';
import { setAhora, db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function pagina(titulo: string, texto: string) {
  return new Response(
    `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1512;color:#efe7d6;font-family:Georgia,serif;padding:24px">
<div style="max-width:460px"><h1 style="font-weight:600;color:#c9aa6e">${titulo}</h1><p style="font-family:Arial,sans-serif;line-height:1.5">${texto}</p>
<p><a style="color:#c9aa6e" href="/">Volver a la oficina</a></p></div></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cookie = req.headers.get('cookie') || '';
  const state = /google_state=([^;]+)/.exec(cookie)?.[1];
  if (url.searchParams.get('error')) return pagina('No se conectó', `Google respondió: ${url.searchParams.get('error')}. Probá de nuevo desde /api/google/conectar.`);
  if (!state || state !== url.searchParams.get('state')) return pagina('No se conectó', 'La sesión de conexión venció. Abrí de nuevo /api/google/conectar.');
  try {
    const email = await canjearCodigo(url.searchParams.get('code') || '', `${url.origin}/api/google/callback`);
    await db().from('agentes').update({ activo: true }).eq('id', 'eleanor');
    await setAhora('eleanor', `Conectada a ${email || 'tu cuenta de Google'}. Revisa tu mail cada 10 minutos.`, 'ok');
    return pagina('Eleanor está conectada', `Ya tiene acceso al mail, la agenda y el Drive de ${email || 'tu cuenta'}. En los próximos minutos hace su primera revisión y te avisa por Telegram.`);
  } catch (e: any) {
    return pagina('No se conectó', `Hubo un problema: ${String(e.message).replace(/</g, '&lt;')}`);
  }
}
