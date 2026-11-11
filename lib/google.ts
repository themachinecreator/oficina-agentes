import { db } from './db';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'openid',
  'email',
];
export const TZ = 'America/Argentina/Buenos_Aires';

function cliente() {
  const id = process.env.GOOGLE_CLIENT_ID, secreto = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secreto) throw new Error('Faltan GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET en Vercel.');
  return { id, secreto };
}

export function urlAutorizacion(redirect: string, state: string) {
  const p = new URLSearchParams({
    client_id: cliente().id,
    redirect_uri: redirect,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: SCOPES.join(' '),
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function canjearCodigo(code: string, redirect: string) {
  const { id, secreto } = cliente();
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: id, client_secret: secreto, redirect_uri: redirect, grant_type: 'authorization_code' }),
  });
  const data = await r.json();
  if (!r.ok || !data.refresh_token) throw new Error(data.error_description || data.error || 'Google no devolvió un refresh token.');
  let email = '';
  if (data.id_token) {
    try { email = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString()).email || ''; } catch { /* sin mail */ }
  }
  await db().from('credenciales').upsert([
    { clave: 'google_refresh_token', valor: data.refresh_token, actualizado: new Date().toISOString() },
    { clave: 'google_email', valor: email, actualizado: new Date().toISOString() },
  ]);
  return email;
}

let cache: { token: string; vence: number } | null = null;

export async function googleConectado() {
  const { data } = await db().from('credenciales').select('valor').eq('clave', 'google_refresh_token').maybeSingle();
  return !!data?.valor;
}

export async function miEmail() {
  const { data } = await db().from('credenciales').select('valor').eq('clave', 'google_email').maybeSingle();
  return data?.valor || '';
}

async function accessToken() {
  if (cache && cache.vence > Date.now() + 60_000) return cache.token;
  const { data } = await db().from('credenciales').select('valor').eq('clave', 'google_refresh_token').maybeSingle();
  if (!data?.valor) throw new Error('Google no está conectado. Abrí /api/google/conectar.');
  const { id, secreto } = cliente();
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secreto, refresh_token: data.valor, grant_type: 'refresh_token' }),
  });
  const t = await r.json();
  if (!r.ok) throw new Error(`Google rechazó el acceso (${t.error}). Volvé a conectar en /api/google/conectar.`);
  cache = { token: t.access_token, vence: Date.now() + t.expires_in * 1000 };
  return cache.token;
}

export async function gapi(url: string, init: RequestInit = {}) {
  const token = await accessToken();
  const r = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google ${r.status}: ${data?.error?.message || 'error'}`);
  return data;
}

// ---------- Gmail ----------
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export type Correo = {
  id: string; hilo: string; de: string; para: string; cc: string; asunto: string; fecha: string;
  messageId: string; referencias: string; cuerpo: string; lista: boolean; masivo: boolean;
};

function decodificar(b64?: string) {
  return b64 ? Buffer.from(b64, 'base64url').toString('utf8') : '';
}
function textoDe(parte: any): string {
  if (!parte) return '';
  if (parte.mimeType === 'text/plain' && parte.body?.data) return decodificar(parte.body.data);
  if (parte.parts) {
    for (const p of parte.parts) { const t = textoDe(p); if (t) return t; }
  }
  if (parte.mimeType === 'text/html' && parte.body?.data) {
    return decodificar(parte.body.data).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  }
  return '';
}

export async function etiquetaProcesado() {
  const nombre = 'Eleanor/Procesado';
  const { labels } = await gapi(`${GMAIL}/labels`);
  const existe = labels.find((l: any) => l.name === nombre);
  if (existe) return existe.id as string;
  for (const padre of ['Eleanor']) {
    if (!labels.find((l: any) => l.name === padre)) await gapi(`${GMAIL}/labels`, { method: 'POST', body: JSON.stringify({ name: padre }) });
  }
  const nueva = await gapi(`${GMAIL}/labels`, { method: 'POST', body: JSON.stringify({ name: nombre }) });
  return nueva.id as string;
}

export async function correosNuevos(max = 8): Promise<Correo[]> {
  const q = 'in:inbox newer_than:2d -label:Eleanor/Procesado -from:me';
  const lista = await gapi(`${GMAIL}/messages?maxResults=${max}&q=${encodeURIComponent(q)}`);
  const ids: string[] = (lista.messages || []).map((m: any) => m.id);
  const out: Correo[] = [];
  for (const id of ids) out.push(await leerCorreo(id));
  return out;
}

export async function leerCorreo(id: string): Promise<Correo> {
  const m = await gapi(`${GMAIL}/messages/${id}?format=full`);
  const h = (n: string) => m.payload.headers.find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value || '';
  const de = h('From');
  return {
    id: m.id, hilo: m.threadId, de, para: h('To'), cc: h('Cc'), asunto: h('Subject'), fecha: h('Date'),
    messageId: h('Message-ID') || h('Message-Id'), referencias: h('References'),
    cuerpo: (textoDe(m.payload) || m.snippet || '').slice(0, 6000),
    lista: !!(h('List-Id') || h('List-Unsubscribe')),
    masivo: /bulk|list|junk/i.test(h('Precedence')) || /no-?reply|noreply|mailer-daemon|notificaciones|notifications/i.test(de),
  };
}

export async function marcarProcesado(id: string, etiqueta: string) {
  await gapi(`${GMAIL}/messages/${id}/modify`, { method: 'POST', body: JSON.stringify({ addLabelIds: [etiqueta] }) });
}

function encabezado(t: string) {
  return /^[\x20-\x7e]*$/.test(t) ? t : `=?UTF-8?B?${Buffer.from(t).toString('base64')}?=`;
}

export async function responderCorreo(c: { hilo: string; de: string; asunto: string; messageId: string; referencias: string }, texto: string) {
  const asunto = /^re:/i.test(c.asunto) ? c.asunto : `Re: ${c.asunto}`;
  const refs = [c.referencias, c.messageId].filter(Boolean).join(' ');
  const cabeceras = [
    `To: ${c.de}`,
    `Subject: ${encabezado(asunto)}`,
    c.messageId ? `In-Reply-To: ${c.messageId}` : '',
    refs ? `References: ${refs}` : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean).join('\r\n');
  const raw = `${cabeceras}\r\n\r\n${Buffer.from(texto).toString('base64')}`;
  await gapi(`${GMAIL}/messages/send`, {
    method: 'POST',
    body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url'), threadId: c.hilo }),
  });
}

export async function buscarCorreos(consulta: string, max = 6) {
  const lista = await gapi(`${GMAIL}/messages?maxResults=${max}&q=${encodeURIComponent(consulta)}`);
  const out = [];
  for (const m of lista.messages || []) {
    const c = await leerCorreo(m.id);
    out.push({ de: c.de, asunto: c.asunto, fecha: c.fecha, extracto: c.cuerpo.slice(0, 500) });
  }
  return out;
}

// ---------- Calendar ----------
const CAL = 'https://www.googleapis.com/calendar/v3';

export async function eventos(desde: string, hasta: string) {
  const p = new URLSearchParams({ timeMin: new Date(desde).toISOString(), timeMax: new Date(hasta).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50', timeZone: TZ });
  const data = await gapi(`${CAL}/calendars/primary/events?${p}`);
  return (data.items || []).map((e: any) => ({
    id: e.id, titulo: e.summary || '(sin título)',
    inicio: e.start?.dateTime || e.start?.date, fin: e.end?.dateTime || e.end?.date,
    todoElDia: !!e.start?.date, lugar: e.location || '',
  }));
}

// Convierte "2026-11-12T16:00" (hora de Buenos Aires) a un instante real.
export function horaBA(local: string) {
  const s = local.length === 16 ? `${local}:00` : local;
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s}-03:00`);
}

export async function superposiciones(inicio: string, fin: string) {
  const a = horaBA(inicio), b = horaBA(fin);
  const lista = await eventos(new Date(a.getTime() - 86400000).toISOString(), new Date(b.getTime() + 86400000).toISOString());
  return lista.filter((e: any) => !e.todoElDia && new Date(e.inicio) < b && new Date(e.fin) > a);
}

export async function crearEvento(ev: { titulo: string; inicio: string; fin?: string; todoElDia?: boolean; descripcion?: string; lugar?: string }) {
  const cuerpo: any = { summary: ev.titulo, description: ev.descripcion || 'Agendado por Eleanor (Oficina Beltrán).', location: ev.lugar || undefined };
  if (ev.todoElDia) {
    const dia = ev.inicio.slice(0, 10);
    const sig = new Date(`${dia}T12:00:00-03:00`); sig.setDate(sig.getDate() + 1);
    cuerpo.start = { date: dia }; cuerpo.end = { date: sig.toISOString().slice(0, 10) };
  } else {
    const fin = ev.fin || new Date(horaBA(ev.inicio).getTime() + 3600000).toISOString();
    cuerpo.start = { dateTime: horaBA(ev.inicio).toISOString(), timeZone: TZ };
    cuerpo.end = { dateTime: horaBA(fin).toISOString(), timeZone: TZ };
  }
  const r = await gapi(`${CAL}/calendars/primary/events`, { method: 'POST', body: JSON.stringify(cuerpo) });
  return r.htmlLink as string;
}

// ---------- Drive ----------
export async function buscarEnDrive(consulta: string) {
  const q = `fullText contains '${consulta.replace(/'/g, "\\'")}' and trashed = false`;
  const p = new URLSearchParams({ q, pageSize: '8', fields: 'files(id,name,mimeType,modifiedTime,webViewLink)', orderBy: 'modifiedTime desc' });
  const data = await gapi(`https://www.googleapis.com/drive/v3/files?${p}`);
  return data.files || [];
}

export async function leerDocumento(id: string) {
  const meta = await gapi(`https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType`);
  const token = await accessToken();
  let url = '';
  if (meta.mimeType === 'application/vnd.google-apps.document') url = `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/plain`;
  else if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') url = `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/csv`;
  else if (meta.mimeType?.startsWith('text/')) url = `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
  else return `${meta.name}: este tipo de archivo (${meta.mimeType}) no se puede leer como texto.`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return `${meta.name}\n\n${(await r.text()).slice(0, 12000)}`;
}

export async function exportarPlanillaCsv(id: string) {
  const token = await accessToken();
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/csv`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`No pude leer la planilla de stock (${r.status}).`);
  return r.text();
}

// Horarios libres de un día (hora de Buenos Aires) entre dos horas, en bloques de la duración pedida.
export async function huecosDelDia(dia: string, desdeHora: number, hastaHora: number, minutos = 60) {
  const lista = await eventos(`${dia}T00:00:00-03:00`, `${dia}T23:59:59-03:00`);
  const ocupados = lista.filter((e: any) => !e.todoElDia).map((e: any) => [new Date(e.inicio).getTime(), new Date(e.fin).getTime()]);
  const libres: string[] = [];
  for (let m = desdeHora * 60; m + minutos <= hastaHora * 60; m += 30) {
    const ini = new Date(`${dia}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00-03:00`).getTime();
    const fin = ini + minutos * 60000;
    if (ini < Date.now() + 2 * 3600000) continue;
    if (!ocupados.some(([a, b]: number[]) => a < fin && b > ini)) libres.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return libres;
}


// ---------- Sheets (Henry) ----------
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

export async function primeraHoja(id: string) {
  const meta = await gapi(`${SHEETS}/${id}?fields=sheets.properties`);
  return meta.sheets[0].properties.title as string;
}

export async function leerRango(id: string, rango: string, render: 'UNFORMATTED_VALUE' | 'FORMULA' = 'UNFORMATTED_VALUE') {
  const p = new URLSearchParams({ valueRenderOption: render, dateTimeRenderOption: 'FORMATTED_STRING' });
  const d = await gapi(`${SHEETS}/${id}/values/${encodeURIComponent(rango)}?${p}`);
  return (d.values || []) as any[][];
}

export async function escribirRango(id: string, rango: string, valores: any[][]) {
  await gapi(`${SHEETS}/${id}/values/${encodeURIComponent(rango)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT', body: JSON.stringify({ range: rango, values: valores }),
  });
}

export async function agregarFila(id: string, hoja: string, fila: any[]) {
  await gapi(`${SHEETS}/${id}/values/${encodeURIComponent(`'${hoja}'!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST', body: JSON.stringify({ values: [fila] }),
  });
}

export function columnaLetra(i: number) {
  let s = ''; i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}
