export function cronAutorizado(req: Request) {
  const secreto = process.env.CRON_SECRET;
  if (!secreto) return false;
  return req.headers.get('x-cron-secret') === secreto || req.headers.get('authorization') === `Bearer ${secreto}`;
}
