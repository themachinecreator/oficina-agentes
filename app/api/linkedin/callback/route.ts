import { canjearCodigoLinkedin } from '@/lib/linkedin';
import { setAhora } from '@/lib/db';

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
  const state = /li_state=([^;]+)/.exec(req.headers.get('cookie') || '')?.[1];
  if (url.searchParams.get('error')) return pagina('No se conectó', `LinkedIn respondió: ${url.searchParams.get('error_description') || url.searchParams.get('error')}.`);
  if (!state || state !== url.searchParams.get('state')) return pagina('No se conectó', 'La sesión de conexión venció. Abrí de nuevo /api/linkedin/conectar.');
  try {
    const nombre = await canjearCodigoLinkedin(url.searchParams.get('code') || '', `${url.origin}/api/linkedin/callback`);
    await setAhora('oliver', `Conectado al LinkedIn de ${nombre || 'Beltrán'}.`, 'ok');
    return pagina('Oliver está conectado', `Ya puede publicar en el LinkedIn de ${nombre || 'tu perfil'}, siempre con tu aprobación por Telegram. La conexión dura 60 días; te aviso antes de que venza.`);
  } catch (e: any) {
    return pagina('No se conectó', `Hubo un problema: ${String(e.message).replace(/</g, '&lt;')}`);
  }
}
