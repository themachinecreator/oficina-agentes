import { db } from './db';
import { hoyISO } from './claude';

// Datos de la cuenta de Instagram y anuncios de Meta (Marketing API) para Victoria.
const IG_ID = process.env.INSTAGRAM_ACCOUNT_ID || '17841447907774982';
const GRAPH = 'https://graph.facebook.com/v23.0';
export const TOPE_MENSUAL_USD = Number(process.env.ADS_TOPE_USD || 30);

async function credencial(clave: string) {
  const { data } = await db().from('credenciales').select('valor').eq('clave', clave).maybeSingle();
  return data?.valor as string | undefined;
}
async function guardar(clave: string, valor: string) {
  await db().from('credenciales').upsert({ clave, valor, actualizado: new Date().toISOString() });
}

export async function graph(ruta: string, cuerpo?: Record<string, unknown>, metodo?: string) {
  const token = await credencial('instagram_token');
  if (!token) throw new Error('Falta el token de Meta.');
  const r = await fetch(`${GRAPH}/${ruta}`, {
    method: metodo || (cuerpo ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.error) throw new Error(`Meta: ${d?.error?.error_user_msg || d?.error?.message || r.status}`);
  return d;
}

// ---------- Métricas de la cuenta ----------
export async function publicacionesRecientes(n = 20) {
  const d = await graph(`${IG_ID}/media?fields=id,caption,media_type,media_product_type,timestamp,like_count,comments_count,permalink&limit=${n}`);
  const lista = (d.data || []) as any[];
  // Alcance, vistas y guardados: necesitan instagram_manage_insights; si no está, seguimos con likes y comentarios.
  await Promise.all(lista.map(async (m) => {
    try {
      const i = await graph(`${m.id}/insights?metric=reach,views,saved,shares,total_interactions`);
      for (const x of i.data || []) m[x.name] = x.values?.[0]?.value ?? x.total_value?.value;
    } catch { /* sin permiso de insights */ }
  }));
  return lista;
}

export async function registrarMetricas() {
  const c = await graph(`${IG_ID}?fields=followers_count,media_count`);
  const posts = await publicacionesRecientes(12).catch(() => []);
  const detalle = posts.map((p) => ({ id: p.id, t: p.timestamp, tipo: p.media_product_type, l: p.like_count, c: p.comments_count, r: p.reach, v: p.views, s: p.saved }));
  await db().from('metricas_ig').upsert({ fecha: hoyISO(), seguidores: c.followers_count, publicaciones: c.media_count, detalle });
  return c.followers_count as number;
}

export async function resumenCuenta() {
  const { data } = await db().from('metricas_ig').select('fecha, seguidores').order('fecha', { ascending: false }).limit(60);
  const hoy = await graph(`${IG_ID}?fields=followers_count,media_count`);
  const serie = data || [];
  const hace = (dias: number) => serie.find((x) => Date.parse(hoyISO()) - Date.parse(x.fecha) >= dias * 86400000);
  const s7 = hace(7), s30 = hace(30);
  const posts = await publicacionesRecientes(20);
  const lineas = posts.map((p) => {
    const extra = [p.views != null && `${p.views} vistas`, p.reach != null && `alcance ${p.reach}`, p.saved != null && `${p.saved} guardados`, p.shares != null && `${p.shares} compartidos`].filter(Boolean).join(', ');
    return `- ${String(p.timestamp).slice(0, 10)} · ${p.media_product_type === 'REELS' ? 'reel' : p.media_type === 'CAROUSEL_ALBUM' ? 'carrusel' : 'post'} · id ${p.id} · "${String(p.caption || '').split('\n')[0].slice(0, 70)}" · ${p.like_count} likes, ${p.comments_count} comentarios${extra ? ', ' + extra : ''}`;
  });
  return [
    `Seguidores hoy: ${hoy.followers_count} · publicaciones: ${hoy.media_count}`,
    s7 ? `Hace 7 días: ${s7.seguidores} (${hoy.followers_count - s7.seguidores >= 0 ? '+' : ''}${hoy.followers_count - s7.seguidores})` : 'Todavía no hay registro de hace 7 días (se guarda uno por día desde hoy).',
    s30 ? `Hace 30 días: ${s30.seguidores} (${hoy.followers_count - s30.seguidores >= 0 ? '+' : ''}${hoy.followers_count - s30.seguidores})` : '',
    posts.some((p) => p.reach != null) ? '' : 'Sin permiso de estadísticas (alcance, vistas, guardados): solo likes y comentarios.',
    'Últimas publicaciones:', ...lineas,
  ].filter(Boolean).join('\n');
}

// ---------- Anuncios ----------
export async function cuentaAds() {
  const id = await credencial('ads_cuenta_id');
  if (!id) return null;
  const act = id.startsWith('act_') ? id : `act_${id}`;
  const info = await graph(`${act}?fields=currency,account_status,name`);
  return { act, moneda: info.currency as string, estado: info.account_status as number, nombre: info.name as string };
}

async function paginaId() {
  const guardada = await credencial('fb_page_id');
  if (guardada) return guardada;
  const d = await graph('me/accounts?fields=id,name,instagram_business_account');
  const p = (d.data || []).find((x: any) => x.instagram_business_account?.id === IG_ID) || d.data?.[0];
  if (!p) throw new Error('No encuentro la página de Facebook: asignale la página al usuario del sistema.');
  await guardar('fb_page_id', p.id);
  return p.id as string;
}

// Cuántas unidades de la moneda de la cuenta vale 1 USD (Meta cobra en la moneda de la cuenta).
async function cotizacion(moneda: string) {
  if (moneda === 'USD') return 1;
  if (moneda !== 'ARS') throw new Error(`La cuenta publicitaria está en ${moneda}; conviene una en USD o ARS.`);
  const r = await fetch('https://dolarapi.com/v1/dolares/tarjeta').then((x) => x.json()).catch(() => null);
  if (!r?.venta) throw new Error('No pude obtener la cotización del dólar tarjeta.');
  return Number(r.venta);
}

export async function gastoDelMes() {
  const c = await cuentaAds();
  if (!c) return null;
  const d = await graph(`${c.act}/insights?fields=spend&date_preset=this_month`);
  const gasto = Number(d.data?.[0]?.spend || 0);
  const tc = await cotizacion(c.moneda);
  const mes = hoyISO().slice(0, 7);
  const { data: activas } = await db().from('campanas').select('presupuesto_usd, inicio').eq('estado', 'activa');
  // Lo comprometido en campañas activas que todavía no se gastó cuenta para el tope.
  const comprometido = (activas || []).filter((x) => String(x.inicio || '').startsWith(mes)).reduce((s, x) => s + Number(x.presupuesto_usd), 0);
  const gastadoUsd = gasto / tc;
  return { gastadoUsd, comprometidoUsd: Math.max(comprometido, gastadoUsd), disponibleUsd: Math.max(0, TOPE_MENSUAL_USD - Math.max(comprometido, gastadoUsd)), moneda: c.moneda };
}

export async function buscarSegmentacion(tipo: 'interes' | 'ubicacion', q: string) {
  const ruta = tipo === 'interes'
    ? `search?type=adinterest&q=${encodeURIComponent(q)}&limit=8&locale=es_LA`
    : `search?type=adgeolocation&q=${encodeURIComponent(q)}&location_types=["city","region"]&country_code=AR&limit=8&locale=es_LA`;
  const d = await graph(ruta);
  return (d.data || []).map((x: any) => tipo === 'interes'
    ? `${x.name} · id ${x.id} · audiencia ${x.audience_size_lower_bound ?? '?'}-${x.audience_size_upper_bound ?? '?'}`
    : `${x.name}${x.region ? ', ' + x.region : ''} · ${x.type} · key ${x.key}`).join('\n') || 'Sin resultados.';
}

export type Publico = {
  edad_min?: number; edad_max?: number; genero?: 'todos' | 'hombres' | 'mujeres';
  ciudades?: { key: string; radio_km?: number }[]; regiones?: { key: string }[]; intereses?: { id: string; name: string }[];
};

function segmentacion(p: Publico) {
  const geo: Record<string, unknown> = {};
  if (p.ciudades?.length) geo.cities = p.ciudades.map((c) => ({ key: c.key, radius: c.radio_km || 25, distance_unit: 'kilometer' }));
  if (p.regiones?.length) geo.regions = p.regiones.map((r) => ({ key: r.key }));
  if (!p.ciudades?.length && !p.regiones?.length) geo.countries = ['AR'];
  return {
    geo_locations: geo,
    age_min: Math.max(18, p.edad_min || 25), age_max: Math.min(65, p.edad_max || 60),
    ...(p.genero === 'hombres' ? { genders: [1] } : p.genero === 'mujeres' ? { genders: [2] } : {}),
    ...(p.intereses?.length ? { flexible_spec: [{ interests: p.intereses.map((i) => ({ id: i.id, name: i.name })) }] } : {}),
    publisher_platforms: ['instagram'],
    instagram_positions: ['stream', 'story', 'reels', 'explore'],
    targeting_automation: { advantage_audience: 0 },
  };
}

export async function lanzarCampana(id: number) {
  const { data: k } = await db().from('campanas').select('*').eq('id', id).maybeSingle();
  if (!k) throw new Error(`No encontré la campaña #${id}.`);
  const c = await cuentaAds();
  if (!c) throw new Error('Falta conectar la cuenta publicitaria.');
  const g = await gastoDelMes();
  if (g && Number(k.presupuesto_usd) > g.disponibleUsd + 0.01) throw new Error(`Supera el tope mensual: quedan ${g.disponibleUsd.toFixed(2)} USD de ${TOPE_MENSUAL_USD}.`);
  const pagina = await paginaId();
  const tc = await cotizacion(c.moneda);
  const nombre = `Victoria #${k.id} · ${k.objetivo} · ${hoyISO()}`;
  const mensajes = k.objetivo === 'mensajes';
  const inicio = new Date(Date.now() + 10 * 60000);
  const fin = new Date(inicio.getTime() + Number(k.dias) * 86400000);
  let campana = '', conjunto = '', anuncio = '';
  try {
    campana = (await graph(`${c.act}/campaigns`, {
      name: nombre, objective: mensajes ? 'OUTCOME_ENGAGEMENT' : 'OUTCOME_TRAFFIC', status: 'PAUSED',
      special_ad_categories: [], is_adset_budget_sharing_enabled: false,
    })).id;
    conjunto = (await graph(`${c.act}/adsets`, {
      name: nombre, campaign_id: campana, status: 'PAUSED',
      lifetime_budget: Math.round(Number(k.presupuesto_usd) * tc * 100),
      start_time: inicio.toISOString(), end_time: fin.toISOString(),
      billing_event: 'IMPRESSIONS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      optimization_goal: mensajes ? 'CONVERSATIONS' : 'VISIT_INSTAGRAM_PROFILE',
      destination_type: mensajes ? 'INSTAGRAM_DIRECT' : 'INSTAGRAM_PROFILE',
      promoted_object: { page_id: pagina },
      targeting: segmentacion(k.publico || {}),
    })).id;
    const creativo = (await graph(`${c.act}/adcreatives`, {
      name: nombre, object_id: pagina, instagram_user_id: IG_ID, source_instagram_media_id: k.media_id,
      call_to_action: mensajes ? { type: 'INSTAGRAM_MESSAGE', value: { app_destination: 'INSTAGRAM' } } : { type: 'VIEW_INSTAGRAM_PROFILE' },
    })).id;
    anuncio = (await graph(`${c.act}/ads`, { name: nombre, adset_id: conjunto, creative: { creative_id: creativo }, status: 'PAUSED' })).id;
    for (const obj of [campana, conjunto, anuncio]) await graph(obj, { status: 'ACTIVE' });
    await db().from('campanas').update({
      estado: 'activa', meta_campaign_id: campana, meta_adset_id: conjunto, meta_ad_id: anuncio,
      inicio: inicio.toISOString(), fin: fin.toISOString(), error: null,
    }).eq('id', id);
    return `Campaña #${id} activa: ${k.presupuesto_usd} USD en ${k.dias} días, hasta el ${fin.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}.`;
  } catch (e: any) {
    if (campana) await graph(campana, undefined, 'DELETE').catch(() => {});
    await db().from('campanas').update({ estado: 'error', error: e.message }).eq('id', id);
    throw e;
  }
}

export async function pausarCampana(id: number) {
  const { data: k } = await db().from('campanas').select('meta_campaign_id').eq('id', id).maybeSingle();
  if (!k?.meta_campaign_id) return `La campaña #${id} no está corriendo.`;
  await graph(k.meta_campaign_id, { status: 'PAUSED' });
  await db().from('campanas').update({ estado: 'pausada' }).eq('id', id);
  return `Campaña #${id} pausada.`;
}

export async function resultadosCampanas() {
  const { data } = await db().from('campanas').select('*').in('estado', ['activa', 'pausada', 'terminada', 'propuesta', 'error']).order('id', { ascending: false }).limit(10);
  if (!data?.length) return 'Todavía no hubo campañas.';
  const c = await cuentaAds().catch(() => null);
  const tc = c ? await cotizacion(c.moneda).catch(() => 1) : 1;
  const ahora = Date.now();
  const lineas: string[] = [];
  for (const k of data) {
    if (k.estado === 'activa' && k.fin && Date.parse(k.fin) < ahora) { await db().from('campanas').update({ estado: 'terminada' }).eq('id', k.id); k.estado = 'terminada'; }
    let res = '';
    if (k.meta_campaign_id) {
      try {
        const d = await graph(`${k.meta_campaign_id}/insights?fields=spend,reach,impressions,actions&date_preset=maximum`);
        const x = d.data?.[0] || {};
        const accion = (t: string) => Number((x.actions || []).find((a: any) => a.action_type === t)?.value || 0);
        const conv = accion('onsite_conversion.messaging_conversation_started_7d');
        const visitas = accion('instagram_profile_visit') || accion('link_click');
        const gasto = Number(x.spend || 0) / tc;
        res = ` · gastó ${gasto.toFixed(2)} USD · alcance ${x.reach || 0}` + (k.objetivo === 'mensajes' ? ` · ${conv} conversaciones${conv ? ` (${(gasto / conv).toFixed(2)} USD c/u)` : ''}` : ` · ${visitas} visitas al perfil${visitas ? ` (${(gasto / visitas).toFixed(2)} USD c/u)` : ''}`);
        await db().from('campanas').update({ resultados: x }).eq('id', k.id);
      } catch { /* sin datos todavía */ }
    }
    lineas.push(`#${k.id} · ${k.objetivo} · ${k.estado} · ${k.presupuesto_usd} USD en ${k.dias} días · ${k.descripcion || ''}${res}${k.error ? ` · error: ${k.error}` : ''}`);
  }
  return lineas.join('\n');
}
