# Lanzador de tweets · Noticiero VOID

Worker de Cloudflare (`void-autopilot`) que lee el RSS de noticierovoid.com, redacta tweets con Workers AI y los publica en X.

Panel: https://void-autopilot.tureganovictor79.workers.dev (contraseña = secreto `ADMIN_TOKEN`).

## Cómo funciona

Cada tweet es de uno de estos dos tipos:

- **🤖 Automático**: tiene una hora y sale solo cuando llega, si el **piloto automático** está encendido.
- **✋ Manual**: no sale nunca solo. Lo lees y pulsas **Publicar ahora**, o lo pasas a automático.

Con el piloto encendido, el worker revisa la cola cada minuto:

1. Publica el siguiente automático que ya toque, respetando el horario, la separación mínima, el máximo diario y el presupuesto.
2. Cada N horas lee el RSS y redacta una tanda de tweets nuevos (automáticos o manuales, según los Ajustes).

Todo se cambia desde la pestaña **Ajustes** del panel.

## Despliegue

Cada push a `main` lo despliega Cloudflare solo (Workers Builds, `npx wrangler deploy`).

Bindings: `DB` (D1 `void-autopilot-db`) y `AI` (Workers AI). Secretos en Cloudflare: `ADMIN_TOKEN`, `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN` y `X_ACCESS_TOKEN_SECRET`.

Si X responde que no hay permiso de escritura: en developer.x.com → tu app → *User authentication settings*, elige **Read and write**. Después **regenera** el Access Token y el Access Token Secret y cámbialos en Cloudflare.

## Código

- `src/index.js`: API, piloto automático (cron), IA, RSS y publicación en X (OAuth 1.0a).
- `src/app.html`: el panel.

Las tablas nuevas son `tweets`, `tw_config`, `tw_log` y `tw_locks`. Las de versiones anteriores (`posts`, `settings`, `events`…) se dejan intactas y no se usan.
