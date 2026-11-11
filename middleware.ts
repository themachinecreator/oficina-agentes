import { NextRequest, NextResponse } from 'next/server';

// Toda la oficina queda detrás de una contraseña, menos la ruta que usa Telegram (que tiene su propio secreto).
export function middleware(req: NextRequest) {
  const clave = process.env.OFICINA_PASSWORD;
  if (!clave) return new NextResponse('Falta configurar OFICINA_PASSWORD en Vercel.', { status: 500 });
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Basic ')) {
    const decodificado = atob(auth.slice(6));
    const pass = decodificado.slice(decodificado.indexOf(':') + 1);
    if (pass === clave) return NextResponse.next();
  }
  return new NextResponse('Acceso restringido', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Oficina Beltran", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ['/((?!api/telegram|api/cron|api/instagram|api/manychat|api/sendpulse|api/foto|_next/static|_next/image|favicon.ico).*)'],
};
