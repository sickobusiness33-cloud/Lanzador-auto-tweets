// Lanzador de tweets — VOID Autopilot
// Lee el RSS de Noticiero VOID, redacta tweets con Workers AI y los publica en X.
// Cada tweet es AUTOMÁTICO (sale solo a su hora) o MANUAL (espera a que pulses Publicar).

import { DurableObject } from "cloudflare:workers";
import APP_HTML from "./app.html";

const VERSION = "9.1.0";
const TICK_MS = 60000;

const DEFAULT_CONFIG = {
  autopilot: false,            // interruptor general: publica los automáticos y genera tweets nuevos
  newTweetsMode: "auto",       // los tweets que genera el piloto: "auto" o "manual"
  generateEveryHours: 3,
  tweetsPerBatch: 4,
  linksPerBatch: 1,            // cuántos tweets de cada tanda llevan el enlace a la noticia
  minMinutesBetween: 45,       // separación mínima entre tweets automáticos
  windowStart: 8,              // hora local a partir de la que se publica
  windowEnd: 23,               // hora local hasta la que se publica
  maxPerDay: 16,               // máximo de tweets automáticos al día
  maxArticleAgeHours: 72,
  monthlyBudgetEur: 16,
  costPerTweetEur: 0.016,
  costPerLinkTweetEur: 0.21,
  rssUrl: "https://noticierovoid.com/rss.xml",
  model: "@cf/zai-org/glm-4.7-flash",
  timezone: "Europe/Madrid",
  lastGenerationAt: null,
  xUsername: null
};

const X_URL_LENGTH = 23; // X cuenta cualquier enlace como 23 caracteres

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Cualquier visita arranca el reloj del piloto si estaba parado.
    if (env.TICKER) ctx.waitUntil(ticker(env).fetch("https://ticker/ensure").catch(() => {}));

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(APP_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
      });
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true, version: VERSION, time: new Date().toISOString() });
    }

    if (!url.pathname.startsWith("/api/")) return json({ ok: false, error: "No encontrado." }, 404);

    try {
      if (!env.DB) throw new UserError("Falta la base de datos D1 (binding DB).");
      if (!env.ADMIN_TOKEN) throw new UserError("Falta el secreto ADMIN_TOKEN en Cloudflare.");
      if (request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
        return json({ ok: false, error: "Contraseña incorrecta." }, 401);
      }

      await ensureSchema(env);
      return await route(request, url, env);
    } catch (error) {
      console.error(error);
      const message = error instanceof UserError ? error.message : `Error interno: ${error.message || error}`;
      if (!(error instanceof UserError)) await log(env, "error", message).catch(() => {});
      return json({ ok: false, error: message }, 400);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(cron(env).catch(async error => {
      console.error("cron", error);
      await log(env, "error", `Piloto automático: ${error.message || error}`).catch(() => {});
    }));
  }
};

class UserError extends Error {}

// ---------------------------------------------------------------------------
// Reloj del piloto
// El plan gratuito solo permite 5 crons por cuenta, así que el piloto se despierta
// con la alarma de un Durable Object (no cuenta para ese límite). Se reprograma
// solo cada minuto y cada visita al panel lo vuelve a arrancar si se hubiera parado.

export class Ticker extends DurableObject {
  async fetch() {
    const next = await this.ctx.storage.getAlarm();
    if (!next || next < Date.now() - 5 * TICK_MS) await this.ctx.storage.setAlarm(Date.now() + 5000);
    const lastTick = (await this.ctx.storage.get("lastTick")) || null;
    return Response.json({ lastTick, nextTick: (await this.ctx.storage.getAlarm()) || null });
  }

  async alarm() {
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    await this.ctx.storage.put("lastTick", Date.now());
    try {
      await cron(this.env);
    } catch (error) {
      console.error("tick", error);
      await log(this.env, "error", `Piloto automático: ${error.message || error}`).catch(() => {});
    }
  }
}

function ticker(env) {
  return env.TICKER.get(env.TICKER.idFromName("main"));
}

async function tickerStatus(env) {
  if (!env.TICKER) return { lastTick: null, nextTick: null, missing: true };
  try {
    return await (await ticker(env).fetch("https://ticker/ensure")).json();
  } catch {
    return { lastTick: null, nextTick: null };
  }
}

// ---------------------------------------------------------------------------
// API

async function route(request, url, env) {
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const path = url.pathname;

  if (path === "/api/state" && request.method === "GET") return json(await getState(env));

  if (request.method !== "POST") throw new UserError("Método no permitido.");

  if (path === "/api/autopilot") {
    const cfg = await saveConfig(env, { autopilot: Boolean(body.on) });
    await log(env, body.on ? "ok" : "warn", body.on ? "Piloto automático ENCENDIDO." : "Piloto automático APAGADO.");
    return json({ ok: true, config: cfg });
  }

  if (path === "/api/config") {
    const cfg = await saveConfig(env, validateConfig(body));
    await log(env, "info", "Ajustes guardados.");
    return json({ ok: true, config: cfg });
  }

  if (path === "/api/generate") {
    const count = clampInt(body.count, 1, 8, 4);
    const mode = body.mode === "manual" ? "manual" : "auto";
    const created = await generateBatch(env, count, mode);
    return json({ ok: true, created });
  }

  if (path === "/api/tweets/create") {
    const text = cleanText(body.text);
    checkLength(text);
    const mode = body.mode === "manual" ? "manual" : "auto";
    if (mode === "auto") checkFutureTime(body.scheduledAt);
    const id = await insertTweet(env, { text, mode, articleUrl: null, articleTitle: "Escrito a mano" });
    if (mode === "auto") await scheduleTweets(env, [id], body.scheduledAt);
    await log(env, "info", `Tweet #${id} escrito a mano (${modeName(mode)}).`);
    return json({ ok: true, id });
  }

  if (path === "/api/reschedule") {
    const n = await rescheduleAll(env);
    await log(env, "info", `Horarios recalculados para ${n} tweets automáticos.`);
    return json({ ok: true, count: n });
  }

  if (path === "/api/test-x") {
    const me = await xRequest(env, "GET", "https://api.x.com/2/users/me");
    const username = me?.data?.username || null;
    await saveConfig(env, { xUsername: username });
    await log(env, "ok", `Conexión con X correcta: @${username}.`);
    return json({ ok: true, username, name: me?.data?.name || null });
  }

  if (path === "/api/test-ai") {
    const cfg = await getConfig(env);
    const text = await askAI(env, cfg.model, "Responde solo con esta frase: La IA de VOID funciona.", 1000);
    return json({ ok: true, model: cfg.model, text });
  }

  const match = path.match(/^\/api\/tweets\/(\d+)\/(edit|mode|publish|retry|delete)$/);
  if (match) return json(await tweetAction(env, Number(match[1]), match[2], body));

  throw new UserError("Ruta no encontrada.");
}

async function tweetAction(env, id, action, body) {
  const tweet = await env.DB.prepare("SELECT * FROM tweets WHERE id=?").bind(id).first();
  if (!tweet) throw new UserError("Ese tweet ya no existe.");

  if (action === "publish") {
    if (!["pending", "error"].includes(tweet.status)) throw new UserError("Este tweet no se puede publicar ahora.");
    const result = await publishTweet(env, tweet, { manual: true });
    return { ok: true, ...result };
  }

  if (tweet.status === "sending") throw new UserError("Este tweet se está enviando ahora mismo.");
  if (tweet.status === "published" && action !== "delete") throw new UserError("Este tweet ya está publicado.");

  if (action === "edit") {
    const text = cleanText(body.text);
    checkLength(text);
    await env.DB.prepare("UPDATE tweets SET text=?, has_link=? WHERE id=?")
      .bind(text, hasLink(text) ? 1 : 0, id).run();
    return { ok: true };
  }

  if (action === "mode") {
    const mode = body.mode === "manual" ? "manual" : "auto";
    if (mode === "auto") checkFutureTime(body.scheduledAt);
    await env.DB.prepare("UPDATE tweets SET mode=?, status='pending', error=NULL, scheduled_at=NULL WHERE id=?")
      .bind(mode, id).run();
    if (mode === "auto") await scheduleTweets(env, [id], body.scheduledAt);
    await log(env, "info", `Tweet #${id} pasado a ${modeName(mode)}.`);
    return { ok: true };
  }

  if (action === "retry") {
    await env.DB.prepare("UPDATE tweets SET status='pending', error=NULL, scheduled_at=NULL WHERE id=?").bind(id).run();
    if (tweet.mode === "auto") await scheduleTweets(env, [id]);
    return { ok: true };
  }

  if (action === "delete") {
    await env.DB.prepare("DELETE FROM tweets WHERE id=?").bind(id).run();
    return { ok: true };
  }
}

async function getState(env) {
  const cfg = await getConfig(env);
  await recoverStuck(env);

  const [pending, published, errors, logRows] = await Promise.all([
    env.DB.prepare("SELECT * FROM tweets WHERE status IN ('pending','sending') ORDER BY scheduled_at IS NULL, scheduled_at, created_at").all(),
    env.DB.prepare("SELECT * FROM tweets WHERE status='published' ORDER BY published_at DESC LIMIT 60").all(),
    env.DB.prepare("SELECT * FROM tweets WHERE status='error' ORDER BY created_at DESC LIMIT 60").all(),
    env.DB.prepare("SELECT * FROM tw_log ORDER BY id DESC LIMIT 80").all()
  ]);

  const rows = pending.results || [];
  const now = new Date();
  const stats = await getStats(env, cfg, now);
  const clock = await tickerStatus(env);

  return {
    ok: true,
    version: VERSION,
    now: now.toISOString(),
    config: cfg,
    stats,
    clock,
    secrets: {
      x: ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"].filter(k => !env[k]),
      ai: Boolean(env.AI)
    },
    auto: rows.filter(t => t.mode === "auto"),
    manual: rows.filter(t => t.mode === "manual"),
    published: published.results || [],
    errors: errors.results || [],
    log: logRows.results || []
  };
}

async function getStats(env, cfg, now) {
  const today = localDate(now, cfg.timezone);
  const month = today.slice(0, 7);
  const recent = await env.DB.prepare(
    "SELECT published_at, cost_eur FROM tweets WHERE status='published' AND published_at >= ?"
  ).bind(new Date(now.getTime() - 32 * 86400000).toISOString()).all();

  let publishedToday = 0;
  let spentMonth = 0;
  for (const row of recent.results || []) {
    const day = localDate(new Date(row.published_at), cfg.timezone);
    if (day === today) publishedToday++;
    if (day.slice(0, 7) === month) spentMonth += Number(row.cost_eur || 0);
  }

  const next = await env.DB.prepare(
    "SELECT id, scheduled_at FROM tweets WHERE status='pending' AND mode='auto' ORDER BY scheduled_at LIMIT 1"
  ).first();

  return {
    publishedToday,
    spentMonth: Math.round(spentMonth * 100) / 100,
    nextAutoAt: next?.scheduled_at || null,
    nextGenerationAt: cfg.lastGenerationAt
      ? new Date(Date.parse(cfg.lastGenerationAt) + cfg.generateEveryHours * 3600000).toISOString()
      : null
  };
}

// ---------------------------------------------------------------------------
// Piloto automático (cron cada minuto)

async function cron(env) {
  await ensureSchema(env);
  const cfg = await getConfig(env);
  await recoverStuck(env);
  if (!cfg.autopilot) return;

  await publishDue(env, cfg);

  const last = cfg.lastGenerationAt ? Date.parse(cfg.lastGenerationAt) : 0;
  if (Date.now() - last < cfg.generateEveryHours * 3600000) return;

  // Si ya hay muchos automáticos en cola no generamos más (evita acumular días de tweets).
  const queued = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tweets WHERE status='pending' AND mode=?"
  ).bind(cfg.newTweetsMode).first();
  if (Number(queued?.n || 0) >= cfg.maxPerDay) return;

  try {
    await generateBatch(env, cfg.tweetsPerBatch, cfg.newTweetsMode, { fromCron: true });
  } catch (error) {
    // Reintenta dentro de 15 minutos en vez de esperar la tanda siguiente.
    const retryAt = Date.now() - cfg.generateEveryHours * 3600000 + 15 * 60000;
    await saveConfig(env, { lastGenerationAt: new Date(retryAt).toISOString() });
    throw error;
  }
}

async function publishDue(env, cfg) {
  const now = new Date();
  if (!inWindow(now, cfg)) return;

  const lastPub = await env.DB.prepare(
    "SELECT published_at FROM tweets WHERE status='published' ORDER BY published_at DESC LIMIT 1"
  ).first();
  if (lastPub && now - Date.parse(lastPub.published_at) < cfg.minMinutesBetween * 60000) return;

  const stats = await getStats(env, cfg, now);
  if (stats.publishedToday >= cfg.maxPerDay) return;

  const due = await env.DB.prepare(
    "SELECT * FROM tweets WHERE status='pending' AND mode='auto' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 1"
  ).bind(now.toISOString()).first();
  if (!due) return;

  try {
    await publishTweet(env, due, { manual: false });
  } catch (error) {
    // El error ya queda guardado en el tweet y en la actividad.
  }
}

// Un tweet que lleva más de 10 minutos "enviándose" se quedó colgado.
async function recoverStuck(env) {
  const limit = new Date(Date.now() - 10 * 60000).toISOString();
  await env.DB.prepare(`
    UPDATE tweets SET status='error',
      error='El envío se quedó a medias. Mira en X si salió antes de reintentar.'
    WHERE status='sending' AND sending_at < ?
  `).bind(limit).run();
}

// ---------------------------------------------------------------------------
// Publicar en X

async function publishTweet(env, tweet, { manual }) {
  const cfg = await getConfig(env);
  checkLength(tweet.text);

  const cost = tweet.has_link ? cfg.costPerLinkTweetEur : cfg.costPerTweetEur;
  const stats = await getStats(env, cfg, new Date());
  if (stats.spentMonth + cost > cfg.monthlyBudgetEur) {
    const message = `Presupuesto del mes agotado (${stats.spentMonth.toFixed(2)} € de ${cfg.monthlyBudgetEur} €). Súbelo en Ajustes.`;
    if (!manual) await log(env, "warn", message);
    throw new UserError(message);
  }

  // Cambio atómico: solo una ejecución puede pasar el tweet a "sending".
  const claim = await env.DB.prepare(
    "UPDATE tweets SET status='sending', sending_at=?, error=NULL WHERE id=? AND status IN ('pending','error')"
  ).bind(new Date().toISOString(), tweet.id).run();
  if (!claim.meta.changes) throw new UserError("Este tweet ya se está enviando.");

  try {
    const result = await xRequest(env, "POST", "https://api.x.com/2/tweets", { text: tweet.text });
    const xId = result?.data?.id || null;
    await env.DB.prepare(
      "UPDATE tweets SET status='published', x_post_id=?, published_at=?, cost_eur=?, error=NULL WHERE id=?"
    ).bind(xId, new Date().toISOString(), cost, tweet.id).run();
    await log(env, "ok", `Tweet #${tweet.id} publicado en X${manual ? " (a mano)" : " (automático)"}.`);
    return { xPostId: xId };
  } catch (error) {
    const message = error.message || String(error);
    await env.DB.prepare("UPDATE tweets SET status='error', error=? WHERE id=?").bind(message, tweet.id).run();
    await log(env, "error", `Tweet #${tweet.id} no se pudo publicar: ${message}`);
    if (error.status === 402) {
      await saveConfig(env, { autopilot: false });
      await log(env, "warn", "Piloto apagado: X dice que no quedan créditos.");
    }
    throw new UserError(message);
  }
}

async function xRequest(env, method, endpoint, payload) {
  const missing = ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"].filter(k => !env[k]);
  if (missing.length) throw new UserError(`Faltan secretos de X en Cloudflare: ${missing.join(", ")}.`);

  const response = await fetch(endpoint, {
    method,
    headers: {
      authorization: await oauthHeader(env, method, endpoint),
      ...(payload ? { "content-type": "application/json" } : {})
    },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(20000)
  });

  const text = await response.text();
  if (response.ok) return JSON.parse(text);

  const error = new UserError(explainXError(response.status, text));
  error.status = response.status;
  throw error;
}

// Traduce los errores de X a algo que se entienda.
function explainXError(status, body) {
  const raw = body.slice(0, 400);
  const lower = body.toLowerCase();
  if (status === 401) return "X rechaza las claves (401). Revisa que las 4 claves X_ sean de la misma app y estén bien copiadas.";
  if (status === 403 && lower.includes("duplicate")) return "X no deja publicar un tweet repetido. Cambia el texto.";
  if (status === 403 && (lower.includes("oauth1-permissions") || lower.includes("not permitted") || lower.includes("permission"))) {
    return "La app de X no tiene permiso de ESCRITURA. En developer.x.com → tu app → User authentication settings, pon «Read and write» y después REGENERA el Access Token y el Access Token Secret y cámbialos en Cloudflare.";
  }
  if (status === 403) return `X ha bloqueado la publicación (403): ${raw}`;
  if (status === 402) return "Tu cuenta de X API no tiene créditos (402). Recarga en developer.x.com.";
  if (status === 429) return "X dice que vas demasiado rápido (429). Se reintentará más tarde.";
  return `X respondió ${status}: ${raw}`;
}

async function oauthHeader(env, method, endpoint) {
  const enc = value => encodeURIComponent(String(value))
    .replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());

  const oauth = {
    oauth_consumer_key: env.X_CONSUMER_KEY,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: "1.0"
  };

  // El cuerpo JSON no entra en la firma; solo los parámetros oauth (el endpoint no lleva query).
  const params = Object.keys(oauth).sort().map(k => `${enc(k)}=${enc(oauth[k])}`).join("&");
  const base = [method.toUpperCase(), enc(endpoint), enc(params)].join("&");
  const signingKey = `${enc(env.X_CONSUMER_SECRET)}&${enc(env.X_ACCESS_TOKEN_SECRET)}`;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(signingKey), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base)));
  oauth.oauth_signature = btoa(String.fromCharCode(...signature));

  return "OAuth " + Object.keys(oauth).sort().map(k => `${enc(k)}="${enc(oauth[k])}"`).join(", ");
}

// ---------------------------------------------------------------------------
// Generar tweets con IA

async function generateBatch(env, count, mode, { fromCron = false } = {}) {
  const lock = await acquireLock(env, "generate", 600);
  if (!lock) throw new UserError("Ya se están generando tweets. Espera un momento.");

  try {
    const cfg = await getConfig(env);
    const articles = await fetchArticles(env, cfg);
    if (fromCron) await saveConfig(env, { lastGenerationAt: new Date().toISOString() });

    if (!articles.length) {
      await log(env, "info", "No hay noticias nuevas en el RSS para tuitear.");
      if (fromCron) return [];
      throw new UserError("No hay noticias nuevas en el RSS (todas tienen ya su tweet o son antiguas).");
    }

    const selected = articles.slice(0, count);
    const created = [];
    const failures = [];

    for (let i = 0; i < selected.length; i++) {
      const article = selected[i];
      const withLink = i >= selected.length - Math.min(cfg.linksPerBatch, selected.length);
      try {
        const text = await writeTweet(env, cfg, article, withLink);
        const id = await insertTweet(env, {
          text, mode, articleUrl: article.url, articleTitle: article.title
        });
        created.push(id);
      } catch (error) {
        failures.push(`${article.title}: ${error.message || error}`);
      }
    }

    if (mode === "auto" && created.length) await scheduleTweets(env, created);

    if (created.length) {
      await log(env, "ok", `${created.length} tweets nuevos creados como ${modeName(mode)}.`);
    }
    if (failures.length) {
      await log(env, "error", `La IA falló en ${failures.length} noticias: ${failures.join(" | ").slice(0, 900)}`);
    }
    if (!created.length) throw new UserError("La IA no pudo redactar ningún tweet. Mira la pestaña Actividad.");

    return created;
  } finally {
    await releaseLock(env, "generate", lock);
  }
}

async function writeTweet(env, cfg, article, withLink) {
  const maxBody = withLink ? 280 - X_URL_LENGTH - 1 : 280;
  const target = Math.min(240, maxBody - 10);

  const prompt = [
    "Escribe UN tweet para la cuenta de Noticiero VOID (noticias de mercados, cripto, tecnología e IA).",
    "Reglas:",
    "- Español de España, tono periodístico, directo y con gancho.",
    "- Si la noticia está en inglés, tradúcela.",
    `- Máximo ${target} caracteres.`,
    "- Usa solo los datos de la noticia. No inventes cifras, fechas ni declaraciones.",
    "- Sin hashtags, sin enlaces, sin comillas alrededor del texto.",
    "- Devuelve solo el texto del tweet, nada más.",
    "",
    `TITULAR: ${article.title}`,
    `RESUMEN: ${article.description.slice(0, 1500) || "(sin resumen)"}`
  ].join("\n");

  let text = "";
  for (let attempt = 0; attempt < 2 && text.length < 20; attempt++) {
    text = tidyAIText(await askAI(env, cfg.model, prompt, 2000));
  }
  if (text.length < 20) throw new Error("respuesta vacía de la IA");

  if (text.length > maxBody) {
    const cut = text.slice(0, maxBody - 1);
    text = cut.slice(0, Math.max(cut.lastIndexOf(" "), maxBody - 30)).trimEnd() + "…";
  }

  return withLink ? `${text}\n${article.url}` : text;
}

async function askAI(env, model, prompt, maxTokens) {
  if (!env.AI) throw new UserError("Falta el binding de Workers AI (AI).");
  const result = await env.AI.run(model, {
    messages: [
      { role: "system", content: "Eres el editor de redes sociales de un medio de noticias. Eres riguroso y conciso." },
      { role: "user", content: prompt }
    ],
    max_tokens: maxTokens
  });
  return extractAIText(result);
}

function extractAIText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const choice = result.choices?.[0];
  if (choice) return choice.message?.content || choice.text || "";
  if (typeof result.response === "string") return result.response;
  if (typeof result.output_text === "string") return result.output_text;
  return "";
}

function tidyAIText(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```\w*\s*|```$/g, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/#\w+/g, "")
    .replace(/^\s*(tweet|texto)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”«»]+|["'“”«»]+$/g, "")
    .trim();
}

// ---------------------------------------------------------------------------
// RSS

async function fetchArticles(env, cfg) {
  const response = await fetch(cfg.rssUrl, {
    headers: { "user-agent": `VOID-Lanzador/${VERSION}`, accept: "application/rss+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new UserError(`No se pudo leer el RSS (${response.status}).`);

  const xml = await response.text();
  const items = [...xml.matchAll(/<(item|entry)\b[^>]*>[\s\S]*?<\/\1\s*>/gi)].map(m => m[0]);
  const now = Date.now();
  const found = new Map();

  for (const block of items) {
    const title = cleanXml(xmlTag(block, "title"));
    let link = decodeXml(xmlTag(block, "link")).trim();
    if (!link) link = block.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] || "";
    const description = cleanXml(
      xmlTag(block, "description") || xmlTag(block, "summary") || xmlTag(block, "content:encoded") || xmlTag(block, "content")
    );
    const date = Date.parse(decodeXml(
      xmlTag(block, "pubDate") || xmlTag(block, "published") || xmlTag(block, "updated") || xmlTag(block, "dc:date")
    ));

    if (!title || !/^https?:\/\//i.test(link)) continue;
    if (Number.isFinite(date) && (now - date) / 3600000 > cfg.maxArticleAgeHours) continue;
    if (!found.has(link)) found.set(link, { title, url: link, description, date: Number.isFinite(date) ? date : 0 });
  }

  const links = [...found.keys()];
  if (!links.length) return [];

  const used = new Set();
  for (let i = 0; i < links.length; i += 50) {
    const chunk = links.slice(i, i + 50);
    const rows = await env.DB.prepare(
      `SELECT article_url FROM tweets WHERE article_url IN (${chunk.map(() => "?").join(",")})`
    ).bind(...chunk).all();
    for (const row of rows.results || []) used.add(row.article_url);
  }

  return [...found.values()].filter(a => !used.has(a.url)).sort((a, b) => b.date - a.date);
}

function xmlTag(block, tag) {
  const t = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return block.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${t}\\s*>`, "i"))?.[1] || "";
}

function decodeXml(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ""; }
}

function cleanXml(value) {
  return decodeXml(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Horarios de los automáticos

async function scheduleTweets(env, ids, exactAt) {
  const cfg = await getConfig(env);

  if (exactAt) {
    const when = checkFutureTime(exactAt);
    for (const id of ids) {
      await env.DB.prepare("UPDATE tweets SET scheduled_at=? WHERE id=?").bind(new Date(when).toISOString(), id).run();
    }
    return;
  }

  const slots = await nextSlots(env, cfg, ids.length, ids);
  for (let i = 0; i < ids.length; i++) {
    await env.DB.prepare("UPDATE tweets SET scheduled_at=? WHERE id=?").bind(slots[i].toISOString(), ids[i]).run();
  }
}

async function rescheduleAll(env) {
  const rows = await env.DB.prepare(
    "SELECT id FROM tweets WHERE status='pending' AND mode='auto' ORDER BY scheduled_at, created_at"
  ).all();
  const ids = (rows.results || []).map(r => r.id);
  if (!ids.length) return 0;
  const cfg = await getConfig(env);
  const slots = await nextSlots(env, cfg, ids.length, ids);
  for (let i = 0; i < ids.length; i++) {
    await env.DB.prepare("UPDATE tweets SET scheduled_at=? WHERE id=?").bind(slots[i].toISOString(), ids[i]).run();
  }
  return ids.length;
}

// Busca huecos respetando: horario de publicación, separación mínima y máximo diario.
async function nextSlots(env, cfg, count, excludeIds = []) {
  const now = Date.now();
  const rows = await env.DB.prepare(`
    SELECT id, COALESCE(published_at, scheduled_at) AS at FROM tweets
    WHERE (status='published' AND published_at >= ?)
       OR (status IN ('pending','sending') AND mode='auto' AND scheduled_at IS NOT NULL)
  `).bind(new Date(now - 2 * 86400000).toISOString()).all();

  const exclude = new Set(excludeIds.map(Number));
  const taken = (rows.results || []).filter(r => !exclude.has(Number(r.id)) && r.at).map(r => Date.parse(r.at));
  const perDay = {};
  for (const t of taken) perDay[localDate(new Date(t), cfg.timezone)] = (perDay[localDate(new Date(t), cfg.timezone)] || 0) + 1;

  const gap = cfg.minMinutesBetween * 60000;
  const step = 5 * 60000;
  const slots = [];
  let candidate = Math.max(now + 2 * 60000, ...taken.map(t => t + gap));

  for (let n = 0; n < count; n++) {
    let guard = 0;
    while (guard++ < 30000) {
      const date = new Date(candidate);
      const day = localDate(date, cfg.timezone);
      if (inWindow(date, cfg) && (perDay[day] || 0) < cfg.maxPerDay) break;
      candidate += step;
    }
    const slot = new Date(Math.ceil(candidate / 60000) * 60000);
    slots.push(slot);
    const day = localDate(slot, cfg.timezone);
    perDay[day] = (perDay[day] || 0) + 1;
    candidate = slot.getTime() + gap;
  }
  return slots;
}

function inWindow(date, cfg) {
  const hour = localHour(date, cfg.timezone);
  const { windowStart: s, windowEnd: e } = cfg;
  if (s === e) return true;
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

function localDate(date, timezone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function localHour(date, timezone) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(date));
}

// ---------------------------------------------------------------------------
// Base de datos
// Usa tablas nuevas (tweets, tw_config, tw_log, tw_locks). Las tablas de versiones
// anteriores (posts, settings, events...) se dejan intactas y no se usan.

let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tweets(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'pending',
      has_link INTEGER NOT NULL DEFAULT 0,
      article_url TEXT,
      article_title TEXT,
      scheduled_at TEXT,
      sending_at TEXT,
      published_at TEXT,
      x_post_id TEXT,
      cost_eur REAL NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS tweets_status_idx ON tweets(status, mode, scheduled_at)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS tweets_article_idx ON tweets(article_url)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS tweets_published_idx ON tweets(published_at)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS tw_config(key TEXT PRIMARY KEY, value TEXT NOT NULL)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tw_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
    )`),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS tw_locks(name TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL)")
  ]);
  schemaReady = true;
}

async function getConfig(env) {
  const row = await env.DB.prepare("SELECT value FROM tw_config WHERE key='config'").first();
  let stored = {};
  try { stored = row ? JSON.parse(row.value) : {}; } catch {}
  return { ...DEFAULT_CONFIG, ...stored };
}

async function saveConfig(env, patch) {
  const next = { ...(await getConfig(env)), ...patch };
  await env.DB.prepare(
    "INSERT INTO tw_config(key, value) VALUES('config', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(JSON.stringify(next)).run();
  return next;
}

function validateConfig(body) {
  const out = {};
  const num = (key, min, max) => {
    if (body[key] === undefined) return;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < min || n > max) throw new UserError(`«${key}» debe estar entre ${min} y ${max}.`);
    out[key] = n;
  };

  num("generateEveryHours", 1, 24);
  num("tweetsPerBatch", 1, 8);
  num("linksPerBatch", 0, 8);
  num("minMinutesBetween", 0, 600);
  num("windowStart", 0, 23);
  num("windowEnd", 0, 24);
  num("maxPerDay", 1, 100);
  num("maxArticleAgeHours", 1, 720);
  num("monthlyBudgetEur", 0, 10000);
  num("costPerTweetEur", 0, 10);
  num("costPerLinkTweetEur", 0, 10);

  for (const key of ["windowStart", "windowEnd", "tweetsPerBatch", "linksPerBatch", "maxPerDay"]) {
    if (out[key] !== undefined) out[key] = Math.round(out[key]);
  }

  if (body.newTweetsMode !== undefined) out.newTweetsMode = body.newTweetsMode === "manual" ? "manual" : "auto";

  if (body.rssUrl !== undefined) {
    try {
      const u = new URL(String(body.rssUrl));
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      out.rssUrl = u.toString();
    } catch {
      throw new UserError("La dirección del RSS no es válida.");
    }
  }

  if (body.model !== undefined) {
    const model = String(body.model).trim();
    if (!/^@cf\/[\w.\-/]+$/.test(model)) throw new UserError("El modelo debe tener la forma @cf/...");
    out.model = model;
  }

  if (body.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("es", { timeZone: String(body.timezone) });
      out.timezone = String(body.timezone);
    } catch {
      throw new UserError("Zona horaria no válida.");
    }
  }

  return out;
}

async function insertTweet(env, { text, mode, articleUrl, articleTitle }) {
  const result = await env.DB.prepare(`
    INSERT INTO tweets(text, mode, status, has_link, article_url, article_title, created_at)
    VALUES(?, ?, 'pending', ?, ?, ?, ?)
  `).bind(text, mode, hasLink(text) ? 1 : 0, articleUrl, articleTitle, new Date().toISOString()).run();
  return result.meta.last_row_id;
}

async function log(env, level, message) {
  await env.DB.prepare("INSERT INTO tw_log(level, message, created_at) VALUES(?, ?, ?)")
    .bind(level, String(message).slice(0, 2000), new Date().toISOString()).run();
  await env.DB.prepare("DELETE FROM tw_log WHERE id <= (SELECT MAX(id) - 500 FROM tw_log)").run();
}

async function acquireLock(env, name, seconds) {
  const now = Date.now();
  const token = crypto.randomUUID();
  await env.DB.prepare("DELETE FROM tw_locks WHERE expires_at < ?").bind(now).run();
  try {
    await env.DB.prepare("INSERT INTO tw_locks(name, token, expires_at) VALUES(?, ?, ?)")
      .bind(name, token, now + seconds * 1000).run();
    return token;
  } catch {
    return null;
  }
}

async function releaseLock(env, name, token) {
  await env.DB.prepare("DELETE FROM tw_locks WHERE name=? AND token=?").bind(name, token).run();
}

// ---------------------------------------------------------------------------
// Utilidades

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function cleanText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function hasLink(text) {
  return /https?:\/\/\S+/i.test(text);
}

export function tweetLength(text) {
  return [...String(text).replace(/https?:\/\/\S+/gi, "x".repeat(X_URL_LENGTH))].length;
}

function checkLength(text) {
  if (!text) throw new UserError("El tweet está vacío.");
  const n = tweetLength(text);
  if (n > 280) throw new UserError(`El tweet tiene ${n} caracteres y X permite 280.`);
}

// Valida una hora elegida a mano (se comprueba antes de tocar la base de datos).
function checkFutureTime(value) {
  if (!value) return null;
  const when = Date.parse(value);
  if (!Number.isFinite(when) || when < Date.now() - 60000) throw new UserError("Elige una fecha y hora futura.");
  return when;
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function modeName(mode) {
  return mode === "auto" ? "automático" : "manual";
}
