import { cronAutorizado } from '@/lib/cron';
import { db } from '@/lib/db';
import { gapi } from '@/lib/google';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Mantenimiento de la planilla Watches (formato y orden). Solo opera sobre esa planilla.
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

export async function POST(req: Request) {
  if (!cronAutorizado(req)) return Response.json({ error: 'No autorizado' }, { status: 401 });
  const { data: c } = await db().from('credenciales').select('valor').eq('clave', 'stock_sheet_id').maybeSingle();
  const id = c?.valor;
  if (!id) return Response.json({ error: 'Falta la planilla' }, { status: 404 });
  const { accion, requests, data, rango } = await req.json().catch(() => ({}));
  try {
    if (accion === 'leer') {
      const meta = await gapi(`${SHEETS}/${id}?fields=sheets(properties,bandedRanges,conditionalFormats,merges)`);
      const hoja = meta.sheets[0].properties.title;
      const valores = await gapi(`${SHEETS}/${id}/values/${encodeURIComponent(rango || `'${hoja}'`)}?valueRenderOption=FORMULA&dateTimeRenderOption=FORMATTED_STRING`);
      return Response.json({ meta, valores: valores.values || [] });
    }
    if (accion === 'valores' && Array.isArray(data)) {
      const r = await gapi(`${SHEETS}/${id}/values:batchUpdate`, { method: 'POST', body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }) });
      return Response.json({ ok: true, celdas: r?.totalUpdatedCells });
    }
    if (accion === 'formato' && Array.isArray(requests)) {
      const r = await gapi(`${SHEETS}/${id}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
      return Response.json({ ok: true, respuestas: (r?.replies || []).length, replies: r?.replies });
    }
    return Response.json({ error: 'Acción desconocida' }, { status: 400 });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
