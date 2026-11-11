const API = 'https://api.telegram.org';

export async function telegram(method: string, body: Record<string, unknown>) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Falta TELEGRAM_BOT_TOKEN en las variables de entorno.');
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function enviar(chatId: number | string, texto: string) {
  // Telegram corta en 4096 caracteres: partimos los mensajes largos.
  const partes = texto.match(/[\s\S]{1,4000}/g) ?? [texto];
  for (const parte of partes) await telegram('sendMessage', { chat_id: chatId, text: parte });
}

export async function escribiendo(chatId: number | string) {
  await telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
}

export function dueñoChatId() {
  return process.env.TELEGRAM_OWNER_ID || '';
}

export async function avisar(texto: string) {
  const chat = dueñoChatId();
  if (chat) await enviar(chat, texto);
}

export async function enviarConBotones(texto: string, botones: { texto: string; dato: string }[]) {
  const chat = dueñoChatId();
  if (!chat) return null;
  const r = await telegram('sendMessage', {
    chat_id: chat,
    text: texto.slice(0, 4000),
    reply_markup: { inline_keyboard: [botones.map((b) => ({ text: b.texto, callback_data: b.dato }))] },
  });
  return r?.result?.message_id ?? null;
}

export async function editarMensaje(messageId: number, texto: string) {
  const chat = dueñoChatId();
  if (!chat || !messageId) return;
  await telegram('editMessageText', { chat_id: chat, message_id: messageId, text: texto.slice(0, 4000) }).catch(() => {});
}

// Manda una imagen (por ejemplo un gráfico) al chat de Beltrán.
export async function enviarFoto(imagen: Buffer, texto = '') {
  const chat = dueñoChatId();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!chat || !token) return;
  const f = new FormData();
  f.append('chat_id', chat);
  if (texto) f.append('caption', texto.slice(0, 1000));
  f.append('photo', new Blob([new Uint8Array(imagen)], { type: 'image/png' }), 'grafico.png');
  await fetch(`${API}/bot${token}/sendPhoto`, { method: 'POST', body: f });
}
