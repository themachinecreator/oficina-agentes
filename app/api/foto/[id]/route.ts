import { metadatosDrive, descargarDrive } from '@/lib/google';
import { archivoPermitido } from '@/lib/fotos';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Sirve una foto o video de "Fotos relojes" para que Instagram la pueda mostrar. Cualquier otro archivo del Drive queda bloqueado.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[\w-]{10,}$/.test(id)) return new Response('No encontrado', { status: 404 });
  try {
    const meta = await metadatosDrive(id);
    if (!/^(image|video)\//.test(meta.mimeType) || !(await archivoPermitido(meta.parents))) return new Response('No encontrado', { status: 404 });
    const r = await descargarDrive(id);
    if (!r.ok || !r.body) return new Response('No disponible', { status: 502 });
    return new Response(r.body, { headers: { 'Content-Type': meta.mimeType, 'Cache-Control': 'public, max-age=3600', ...(meta.size ? { 'Content-Length': String(meta.size) } : {}) } });
  } catch {
    return new Response('No encontrado', { status: 404 });
  }
}
