# Oficina Beltrán

Oficina 3D de agentes de IA para beltranrelojes y secretaría personal. Etapa 3: la oficina publicada y Arthur Whitmore (jefe de oficina) respondiendo por Telegram. El resto de los agentes ya aparece en la oficina y recibe tareas en cola; se conectan en las próximas etapas.

## Cómo está armado

- `public/oficina.html` — la oficina 3D. Lee el estado real cada 15 segundos.
- `app/api/telegram` — recibe los mensajes del bot y responde como Arthur.
- `lib/arthur.ts` — personalidad, reglas y herramientas de Arthur (crear, ver y cerrar tareas).
- `app/api/estado`, `app/api/tareas`, `app/api/aprobaciones` — datos para la oficina.
- `middleware.ts` — toda la oficina queda detrás de una contraseña.
- `supabase/schema.sql` — tablas: agentes, tareas, mensajes y aprobaciones.

## Puesta en marcha (una sola vez)

### 1. Base de datos (Supabase)
1. En el proyecto de Supabase: **SQL Editor** → **New query**.
2. Pegá todo el contenido de `supabase/schema.sql` y tocá **Run**.
3. En **Project Settings → API Keys** (o **API**), copiá:
   - la **URL del proyecto** → `SUPABASE_URL`
   - la clave **secret** o **service_role** → `SUPABASE_SERVICE_ROLE_KEY` (no la "anon/publishable").

### 2. Publicar en Vercel
1. En vercel.com → **Add New → Project** → importá `themachinecreator/oficina-agentes`.
2. Antes de **Deploy**, abrí **Environment Variables** y cargá:

| Variable | Valor |
| --- | --- |
| `ANTHROPIC_API_KEY` | La clave nueva de Claude Console |
| `CLAUDE_MODEL` | `claude-haiku-5-5` |
| `TELEGRAM_BOT_TOKEN` | El token nuevo de @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Una frase larga inventada, solo letras, números, `_` y `-` (por ejemplo `arthur_whitmore_42_parkave`) |
| `TELEGRAM_OWNER_ID` | Dejalo vacío por ahora (paso 4) |
| `SUPABASE_URL` | Del paso 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | Del paso 1 |
| `OFICINA_PASSWORD` | La contraseña con la que vas a entrar a la oficina |

3. Tocá **Deploy**.

### 3. Conectar el bot
1. Abrí `https://<tu-proyecto>.vercel.app/api/configurar-webhook`.
2. El navegador pide usuario y contraseña: usuario cualquiera, contraseña = `OFICINA_PASSWORD`.
3. Tiene que decir "Listo: Arthur ya recibe tus mensajes".

### 4. Hacer que Arthur te reconozca
1. Escribile cualquier cosa al bot en Telegram: te responde con tu ID.
2. Cargá ese número en Vercel como `TELEGRAM_OWNER_ID`.
3. **Deployments** → último deploy → **Redeploy**.
4. Mandale `/start`. Desde ahora solo te responde a vos.

## Eleanor (Google)

1. Google Cloud (con la cuenta de UdeSA): proyecto `Oficina Beltran`, APIs de Gmail, Calendar y Drive habilitadas, pantalla de consentimiento **Interna**, cliente OAuth web con redirección `https://oficina-agentes-351k.vercel.app/api/google/callback`.
2. En Vercel: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y `CRON_SECRET`.
3. Abrí `/api/google/conectar` y aceptá los permisos.
4. Volvé a abrir `/api/configurar-webhook` para que Telegram mande también los botones de aprobación.

Qué hace:
- Cada 10 minutos (pg_cron en Supabase llama a `/api/cron/eleanor`) lee los mails nuevos de la bandeja de entrada y decide: responder sola, informar, consultarte con botones o ignorar. Los procesados quedan con la etiqueta `Eleanor/Procesado`.
- Agenda fechas concretas sin superponer eventos.
- Todos los días a las 8:00 te manda el resumen del día (`/api/cron/resumen`).
- Arthur usa la agenda, el mail y el Drive en su nombre cuando le pedís algo por Telegram.
- Firma de los mails: `credenciales.eleanor_firma` = `beltran` (por defecto) o `asistente`.

## Seguridad
- Las claves viven solo en Vercel. Nunca en el código ni en el chat.
- El gasto de la API está limitado desde Claude Console (límite mensual).
