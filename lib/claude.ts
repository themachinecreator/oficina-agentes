import Anthropic from '@anthropic-ai/sdk';

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
export const MODELO = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';

export function fechaBA() {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'full', timeStyle: 'short',
  }).format(new Date());
}

export function hoyISO() {
  // Fecha de hoy en Buenos Aires, AAAA-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
}

export const PERFIL_BELTRAN = `Beltrán Symonds Dagnino: estudiante de Negocios Digitales en la Universidad de San Andrés (UdeSA) y dueño de beltranrelojes, un emprendimiento de compra y venta de relojes. Recibe visitas para ver relojes en Av. Alvear 1491 (nunca después de las 18; martes y jueves, no antes de las 15).`;
