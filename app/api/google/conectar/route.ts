import { urlAutorizacion } from '@/lib/google';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const origen = new URL(req.url).origin;
  const state = crypto.randomUUID();
  const url = urlAutorizacion(`${origen}/api/google/callback`, state);
  return new Response(null, {
    status: 302,
    headers: { Location: url, 'Set-Cookie': `google_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600` },
  });
}
