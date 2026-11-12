# Lanzador de tweets · Noticiero VOID

Worker de Cloudflare (`void-autopilot`) con **dos bots de X** en el mismo panel, cada uno con su cuenta, su app de X (sus créditos), su plan, su presupuesto y su botón de marcha:

- **📰 Noticiero VOID**: tuitea noticias del RSS de noticierovoid.com por temas.
- **💧 StayLiquid**: tuitea las operaciones ganadoras del bot de stayliquid.tech (historial público `/api/copy/history`), noticias de memecoins y cripto de noticierovoid.com y promoción de la app. Sus tweets solo enlazan a stayliquid.tech y no nombran otras plataformas.

Panel: https://void-autopilot.tureganovictor79.workers.dev (contraseña = secreto `ADMIN_TOKEN`).

## Cómo funciona

Cada tweet es de uno de estos dos tipos:

- **🤖 Automático**: tiene una hora y sale solo cuando llega, mientras el bot esté **en marcha** (botón «▶ Poner en marcha»).
- **✋ Manual**: no sale nunca solo. Lo lees y pulsas **Publicar ahora**, o lo pasas a automático.

Con el bot en marcha, el worker revisa la cola cada minuto (con la alarma de un Durable Object, porque el plan gratuito solo permite 5 crons por cuenta):

1. Publica el siguiente automático que ya toque, respetando el horario, la separación mínima, el máximo diario y el presupuesto.
2. Mantiene la cola llena según el **Plan del día**: cuántos tweets de cada tema (Cripto, Macro, Materias primas, IA, Acciones, Finanzas, Política, Otros). La suma es el máximo diario. 1 de cada 4 lleva el enlace a la noticia en noticierovoid.com (configurable).

Los tweets se escriben en **inglés** (o en español, si se elige en el plan). El RSS no trae categorías, así que cada noticia se clasifica por palabras clave (`TOPICS` en `src/index.js`).

Todo se cambia desde la pestaña **Ajustes** del panel.

## Despliegue

Cada push a `main` lo despliega Cloudflare solo (Workers Builds, `npx wrangler deploy`).

Bindings: `DB` (D1 `void-autopilot-db`) y `AI` (Workers AI). Secretos en Cloudflare: `ADMIN_TOKEN`, `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN` y `X_ACCESS_TOKEN_SECRET`.

### Cuenta de X

El bot publica en la cuenta conectada desde **Ajustes → Conectar mi cuenta de X** (OAuth 1.0a de 3 pasos). Las claves de esa cuenta se guardan en D1 (`tw_config`, clave `x_account`). Si no hay ninguna conectada, usa los secretos `X_ACCESS_TOKEN` / `X_ACCESS_TOKEN_SECRET`.

Antes de conectar, en developer.x.com → tu app → *User authentication settings*: permisos **Read and write**, tipo **Web App, Automated App or Bot** y Callback URI `https://void-autopilot.tureganovictor79.workers.dev/x/callback`.

Si X responde que no hay permiso de escritura: en developer.x.com → tu app → *User authentication settings*, elige **Read and write**. Después **regenera** el Access Token y el Access Token Secret y cámbialos en Cloudflare.

## Código

- `src/index.js`: API, piloto automático (cron), IA, RSS y publicación en X (OAuth 1.0a).
- `src/app.html`: el panel.

Las tablas nuevas son `tweets`, `tw_config`, `tw_log` y `tw_locks`. Las de versiones anteriores (`posts`, `settings`, `events`…) se dejan intactas y no se usan.
