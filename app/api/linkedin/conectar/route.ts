import { urlConexion } from '@/lib/linkedin';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const origen = new URL(req.url).origin;
  const state = crypto.randomUUID();
  try {
    const url = await urlConexion(`${origen}/api/linkedin/callback`, state);
    return new Response(null, { status: 302, headers: { Location: url, 'Set-Cookie': `li_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600` } });
  } catch (e: any) {
    return new Response(e.message, { status: 500 });
  }
}
