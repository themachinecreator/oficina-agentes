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
