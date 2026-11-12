import { cronAutorizado } from '@/lib/cron';
import { telegram } from '@/lib/telegram';
import { gapi } from '@/lib/google';

export const dynamic = 'force-dynamic';

// Estado del webhook de Telegram y permisos de Google, para encontrar fallas.
export async function GET(req: Request) {
  if (!cronAutorizado(req)) return Response.json({ error: 'No autorizado' }, { status: 401 });
  const webhook = await telegram('getWebhookInfo', {}).catch((e: any) => ({ error: e.message }));
  const perfil = await gapi('https://gmail.googleapis.com/gmail/v1/users/me/profile').catch((e: any) => ({ error: e.message }));
  return Response.json({ webhook, gmail: perfil });
}
