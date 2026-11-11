// Lanzador de tweets — VOID Autopilot
// Lee el RSS de Noticiero VOID, redacta tweets con Workers AI y los publica en X.
// Cada tweet es AUTOMÁTICO (sale solo a su hora) o MANUAL (espera a que pulses Publicar).

import { DurableObject } from "cloudflare:workers";
import APP_HTML from "./app.html";

const VERSION = "9.3.0";
const TICK_MS = 60000;

const DEFAULT_CONFIG = {
  autopilot: false,            // interruptor general: publica los automáticos y genera tweets nuevos
  newTweetsMode: "auto",       // los tweets que genera el piloto: "auto" o "manual"
  linkEvery: 4,                // 1 de cada N tweets lleva el enlace a la noticia en noticierovoid.com (0 = nunca)
  language: "en",              // idioma de los tweets: "en" (inglés) o "es" (español)
  // Plan del día: cuántos tweets de cada tema. La suma es el máximo diario.
  topicPlan: { crypto: 4, stocks: 4, macro: 3, ai: 3, commodities: 1, finance: 1, politics: 0, other: 0 },
  minMinutesBetween: 45,       // separación mínima entre tweets automáticos
  windowStart: 8,              // hora local a partir de la que se publica
  windowEnd: 23,               // hora local hasta la que se publica
  maxPerDay: 16,               // se calcula solo: es la suma del plan del día
  maxArticleAgeHours: 72,
  monthlyBudgetEur: 16,
  costPerTweetEur: 0.016,
  costPerLinkTweetEur: 0.21,
  rssUrl: "https://noticierovoid.com/rss.xml",
  model: "@cf/zai-org/glm-4.7-flash",
  timezone: "Europe/Madrid",
  xUsername: null
};

const X_URL_LENGTH = 23; // X cuenta cualquier enlace como 23 caracteres

// Temas. El RSS no trae categorías, así que cada noticia se clasifica por palabras clave
// (el titular pesa el triple que el resumen). En empate gana el que va antes en la lista.
const TOPICS = {
  crypto: { label: "Cripto", emoji: "🪙", words: ["bitcoin", "btc", "ethereum", "ether", "eth", "crypto", "cryptocurrency", "cryptocurrencies", "solana", "xrp", "ripple", "dogecoin", "stablecoin", "stablecoins", "tether", "usdt", "usdc", "blockchain", "defi", "nft", "nfts", "token", "tokens", "tokenized", "tokenization", "binance", "coinbase", "kraken", "web3", "altcoin", "altcoins", "memecoin", "satoshi", "digital asset", "digital assets", "wallet", "cz", "saylor", "microstrategy", "on-chain", "onchain"] },
  macro: { label: "Macro y bancos centrales", emoji: "🏦", words: ["fed", "federal reserve", "ecb", "boe", "boj", "central bank", "interest rate", "interest rates", "rate cut", "rate cuts", "rate hike", "inflation", "cpi", "pce", "gdp", "jobs report", "payrolls", "unemployment", "treasury", "treasuries", "yields", "recession", "tariff", "tariffs", "warsh", "powell", "lagarde", "economy", "monetary policy", "dollar", "forex", "currency", "currencies", "euro", "yen"] },
  commodities: { label: "Materias primas", emoji: "🛢️", words: ["oil", "crude", "brent", "wti", "opec", "gold", "silver", "copper", "natural gas", "lng", "coal", "lithium", "uranium", "wheat", "commodity", "commodities", "mine", "mining", "rare earths", "barrel"] },
  ai: { label: "IA y tecnología", emoji: "🤖", words: ["ai", "artificial intelligence", "openai", "chatgpt", "gpt", "nvidia", "gemini", "anthropic", "claude", "copilot", "llm", "chip", "chips", "semiconductor", "semiconductors", "cloud", "cybersecurity", "software", "agent", "agents", "agentic", "robot", "robotics", "quantum", "data center", "google", "alphabet", "microsoft", "apple", "meta", "amazon", "tesla", "github"] },
  stocks: { label: "Acciones y resultados", emoji: "📈", words: ["stock", "stocks", "shares", "earnings", "eps", "revenue", "price target", "upgrade", "upgrades", "downgrade", "downgrades", "ipo", "dividend", "nasdaq", "s&p", "dow", "wall street", "guidance", "buyback", "q1", "q2", "q3", "q4", "quarterly", "beats", "misses", "rally", "market cap", "analyst", "rating", "estimates"] },
  finance: { label: "Finanzas y empresas", emoji: "💼", words: ["bank", "banks", "banking", "fund", "funds", "aum", "etf", "asset manager", "hedge fund", "private equity", "acquisition", "acquires", "merger", "deal", "private placement", "bond", "bonds", "insurer", "insurance", "loan", "loans", "credit", "capital", "venture", "raises", "funding", "capex", "leverage"] },
  politics: { label: "Política y geopolítica", emoji: "🌍", words: ["election", "elections", "midterm", "midterms", "campaign", "governor", "president", "trump", "congress", "senate", "war", "sanctions", "china", "russia", "ukraine", "israel", "iran", "geopolitical", "government", "minister", "parliament", "regulation", "regulators", "sec"] },
  other: { label: "Otros", emoji: "📰", words: [] }
};

const TOPIC_PATTERNS = Object.fromEntries(Object.entries(TOPICS).map(([key, t]) => [
  key,
  t.words.map(w => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`, "i"))
]));

export function classifyTopic(title, description = "") {
  let best = "other";
  let bestScore = 0;
  for (const [key, patterns] of Object.entries(TOPIC_PATTERNS)) {
    let score = 0;
    for (const re of patterns) {
      if (re.test(title)) score += 3;
      else if (re.test(description)) score += 1;
    }
    if (score > bestScore) { best = key; bestScore = score; }
  }
  return best;
}

function planTotal(plan) {
  return Object.keys(TOPICS).reduce((sum, key) => sum + (Number(plan?.[key]) || 0), 0);
}

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

    // Vuelta desde X después de autorizar la app (paso 3 del OAuth). Es pública, pero solo
    // acepta un oauth_token que este mismo panel pidió hace menos de 15 minutos.
    if (url.pathname === "/x/callback") {
      let result = "ok";
      try {
        await ensureSchema(env);
        await finishXConnect(env, url);
      } catch (error) {
        console.error("x callback", error);
        result = encodeURIComponent(error.message || String(error));
      }
      return Response.redirect(new URL(`/?x=${result}`, url).toString(), 302);
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
    if (body.on) await setKey(env, "nextGenerationCheck", 0); // rellena la cola enseguida
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
    const topic = TOPICS[body.topic] ? body.topic : null;
    const created = await generateBatch(env, count, mode, { topic });
    return json({ ok: true, created });
  }

  if (path === "/api/tweets/create") {
    const text = cleanText(body.text);
    checkLength(text);
    const mode = body.mode === "manual" ? "manual" : "auto";
    if (mode === "auto") checkFutureTime(body.scheduledAt);
    const topic = TOPICS[body.topic] ? body.topic : classifyTopic(text);
    const id = await insertTweet(env, { text, mode, articleUrl: null, articleTitle: "Escrito a mano", topic });
    if (mode === "auto") await scheduleTweets(env, [id], body.scheduledAt);
    await log(env, "info", `Tweet #${id} escrito a mano (${modeName(mode)}).`);
    return json({ ok: true, id });
  }

  // Rehace con la IA (en el idioma configurado) hasta 3 tweets pendientes que no estén en ese idioma.
  if (path === "/api/rewrite-pending") {
    const cfg = await getConfig(env);
    const rows = await env.DB.prepare(
      "SELECT * FROM tweets WHERE status IN ('pending','error') AND article_url IS NOT NULL ORDER BY scheduled_at IS NULL, scheduled_at, id"
    ).all();
    const todo = (rows.results || []).filter(t => looksSpanish(t.text) !== (cfg.language === "es"));
    let done = 0;
    for (const tweet of todo.slice(0, 3)) {
      await rewriteTweet(env, cfg, tweet);
      done++;
    }
    return json({ ok: true, done, remaining: todo.length - done });
  }

  if (path === "/api/reschedule") {
    const n = await rescheduleAll(env);
    await log(env, "info", `Horarios recalculados para ${n} tweets automáticos.`);
    return json({ ok: true, count: n });
  }

  // Paso 1 del OAuth: pide a X un token temporal y devuelve la página donde el usuario autoriza.
  if (path === "/api/x/connect") {
    if (!env.X_CONSUMER_KEY || !env.X_CONSUMER_SECRET) {
      throw new UserError("Faltan X_CONSUMER_KEY y X_CONSUMER_SECRET (las claves de la app de X) en Cloudflare.");
    }
    const callback = new URL("/x/callback", url).toString();
    const body = await xOAuthStep(env, "https://api.x.com/oauth/request_token", { oauth_callback: callback }, "");
    if (body.get("oauth_callback_confirmed") !== "true") throw new UserError("X no ha aceptado la dirección de vuelta.");
    const token = body.get("oauth_token");
    await env.DB.prepare("DELETE FROM tw_config WHERE key LIKE 'x_request_%'").run(); // solo una conexión pendiente
    await setKey(env, `x_request_${token}`, JSON.stringify({ secret: body.get("oauth_token_secret"), at: Date.now() }));
    return json({ ok: true, url: `https://api.x.com/oauth/authorize?oauth_token=${encodeURIComponent(token)}`, callback });
  }

  if (path === "/api/x/disconnect") {
    await env.DB.prepare("DELETE FROM tw_config WHERE key='x_account'").run();
    await saveConfig(env, { xUsername: null });
    await log(env, "warn", "Cuenta de X del panel desconectada: se vuelven a usar las claves de Cloudflare.");
    return json({ ok: true });
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

  const match = path.match(/^\/api\/tweets\/(\d+)\/(edit|mode|publish|retry|delete|rewrite)$/);
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

  if (action === "rewrite") {
    if (!tweet.article_url) throw new UserError("Este tweet no viene de una noticia: edítalo a mano.");
    await rewriteTweet(env, await getConfig(env), tweet);
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
    xAccount: await xAccountInfo(env),
    secrets: {
      x: (await getXAccount(env) ? ["X_CONSUMER_KEY", "X_CONSUMER_SECRET"] : ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"]).filter(k => !env[k]),
      ai: Boolean(env.AI)
    },
    topics: Object.fromEntries(Object.entries(TOPICS).map(([k, t]) => [k, { label: t.label, emoji: t.emoji }])),
    prepared: countByTopic(rows.filter(t => t.mode === cfg.newTweetsMode)),
    auto: rows.filter(t => t.mode === "auto"),
    manual: rows.filter(t => t.mode === "manual"),
    published: published.results || [],
    errors: errors.results || [],
    log: logRows.results || []
  };
}

function countByTopic(rows) {
  const out = Object.fromEntries(Object.keys(TOPICS).map(k => [k, 0]));
  for (const t of rows) out[TOPICS[t.topic] ? t.topic : "other"]++;
  return out;
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
  const next24 = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tweets WHERE status='pending' AND mode='auto' AND scheduled_at <= ?"
  ).bind(new Date(now.getTime() + 86400000).toISOString()).first();

  return {
    publishedToday,
    spentMonth: Math.round(spentMonth * 100) / 100,
    nextAutoAt: next?.scheduled_at || null,
    queued24h: Number(next24?.n || 0)
  };
}

// ---------------------------------------------------------------------------
// Piloto automático (cron cada minuto)

async function cron(env) {
  await ensureSchema(env);
  const cfg = await getConfig(env);
  await recoverStuck(env);
  if (!cfg.autopilot) return;

  await fixUnscheduled(env);
  await publishDue(env, cfg);

  // Mantiene la cola llena: siempre hay tweets preparados para las próximas 24 h
  // (tantos como el máximo diario). Genera de 4 en 4 para que cada vuelta sea corta.
  const nextCheck = Number(await getKey(env, "nextGenerationCheck")) || 0;
  if (Date.now() < nextCheck) return;

  const queued = await env.DB.prepare(
    "SELECT topic FROM tweets WHERE status='pending' AND mode=?"
  ).bind(cfg.newTweetsMode).all();
  const have = countByTopic(queued.results || []);
  const quota = {};
  let missing = 0;
  for (const key of Object.keys(TOPICS)) {
    quota[key] = Math.max(0, (Number(cfg.topicPlan?.[key]) || 0) - have[key]);
    missing += quota[key];
  }
  if (missing <= 0) return;

  let wait = 20 * 60000;
  try {
    const created = await generateBatch(env, Math.min(4, missing), cfg.newTweetsMode, { fromCron: true, quota });
    if (created === null) return;            // otra vuelta ya está generando
    if (created.length) wait = 60000;        // hay noticias: sigue llenando en el siguiente minuto
  } finally {
    await setKey(env, "nextGenerationCheck", Date.now() + wait);
  }
}

// Un automático sin hora (por ejemplo si una vuelta se cortó) recibe el siguiente hueco libre.
async function fixUnscheduled(env) {
  const rows = await env.DB.prepare(
    "SELECT id FROM tweets WHERE status='pending' AND mode='auto' AND scheduled_at IS NULL ORDER BY id"
  ).all();
  const ids = (rows.results || []).map(r => r.id);
  if (ids.length) await scheduleTweets(env, ids);
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

// Cuenta en la que publica el bot: la conectada desde el panel ("Conectar mi cuenta de X")
// o, si no hay ninguna, la de los secretos X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET.
async function getXAccount(env) {
  try {
    const stored = JSON.parse(await getKey(env, "x_account") || "null");
    if (stored?.token && stored?.secret) return stored;
  } catch {}
  return null;
}

async function xAccountInfo(env) {
  const stored = await getXAccount(env);
  if (stored) return { source: "panel", username: stored.username || null, connectedAt: stored.connectedAt || null };
  return { source: env.X_ACCESS_TOKEN ? "cloudflare" : "none", username: null };
}

async function xRequest(env, method, endpoint, payload) {
  const stored = await getXAccount(env);
  const required = stored ? ["X_CONSUMER_KEY", "X_CONSUMER_SECRET"] : ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"];
  const missing = required.filter(k => !env[k]);
  if (missing.length) throw new UserError(`Faltan secretos de X en Cloudflare: ${missing.join(", ")}.`);
  const token = stored ? stored.token : env.X_ACCESS_TOKEN;
  const tokenSecret = stored ? stored.secret : env.X_ACCESS_TOKEN_SECRET;

  const response = await fetch(endpoint, {
    method,
    headers: {
      authorization: await oauthHeader(env, method, endpoint, { oauth_token: token }, tokenSecret),
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

// Firma OAuth 1.0a (HMAC-SHA1). `extra` añade parámetros oauth_* (token, callback, verifier).
async function oauthHeader(env, method, endpoint, extra, tokenSecret) {
  const enc = value => encodeURIComponent(String(value))
    .replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());

  const oauth = {
    oauth_consumer_key: env.X_CONSUMER_KEY,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...extra
  };

  // El cuerpo JSON no entra en la firma; solo los parámetros oauth (el endpoint no lleva query).
  const params = Object.keys(oauth).sort().map(k => `${enc(k)}=${enc(oauth[k])}`).join("&");
  const base = [method.toUpperCase(), enc(endpoint), enc(params)].join("&");
  const signingKey = `${enc(env.X_CONSUMER_SECRET)}&${enc(tokenSecret || "")}`;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(signingKey), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base)));
  oauth.oauth_signature = btoa(String.fromCharCode(...signature));

  return "OAuth " + Object.keys(oauth).sort().map(k => `${enc(k)}="${enc(oauth[k])}"`).join(", ");
}

// Pasos 1 y 3 del OAuth de 3 patas: X responde con un formulario (a=1&b=2), no con JSON.
async function xOAuthStep(env, endpoint, extra, tokenSecret) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: await oauthHeader(env, "POST", endpoint, extra, tokenSecret) },
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 && /callback/i.test(text)) {
      throw new UserError("X no reconoce la dirección de vuelta. Añade la «Callback URI» que sale en el panel en developer.x.com → tu app → User authentication settings.");
    }
    throw new UserError(explainXError(response.status, text));
  }
  return new URLSearchParams(text);
}

async function finishXConnect(env, url) {
  if (url.searchParams.get("denied")) throw new Error("Has cancelado la autorización en X.");
  const token = url.searchParams.get("oauth_token");
  const verifier = url.searchParams.get("oauth_verifier");
  if (!token || !verifier) throw new Error("X no ha devuelto los datos de la autorización.");

  const key = `x_request_${token}`;
  const pending = JSON.parse(await getKey(env, key) || "null");
  await env.DB.prepare("DELETE FROM tw_config WHERE key=?").bind(key).run();
  if (!pending || Date.now() - pending.at > 15 * 60000) throw new Error("La autorización ha caducado. Vuelve a pulsar «Conectar mi cuenta de X».");

  const body = await xOAuthStep(env, "https://api.x.com/oauth/access_token",
    { oauth_token: token, oauth_verifier: verifier }, pending.secret);
  const account = {
    token: body.get("oauth_token"),
    secret: body.get("oauth_token_secret"),
    userId: body.get("user_id"),
    username: body.get("screen_name"),
    connectedAt: new Date().toISOString()
  };
  if (!account.token || !account.secret) throw new Error("X no ha devuelto las claves de la cuenta.");

  await setKey(env, "x_account", JSON.stringify(account));
  await saveConfig(env, { xUsername: account.username });
  await log(env, "ok", `Cuenta de X conectada: @${account.username}. El bot publicará en ella.`);
}

// ---------------------------------------------------------------------------
// Generar tweets con IA

async function generateBatch(env, count, mode, { fromCron = false, topic = null, quota = null } = {}) {
  const lock = await acquireLock(env, "generate", 600);
  if (!lock) {
    if (fromCron) return null;
    throw new UserError("Ya se están generando tweets. Espera un momento.");
  }

  try {
    const cfg = await getConfig(env);
    let articles = await fetchArticles(env, cfg);
    if (topic) articles = articles.filter(a => a.topic === topic);

    // Con plan diario: solo coge noticias de los temas a los que aún les faltan tweets.
    let selected = [];
    if (quota) {
      const left = { ...quota };
      for (const a of articles) {
        if (selected.length >= count) break;
        if (left[a.topic] > 0) { selected.push(a); left[a.topic]--; }
      }
    } else {
      selected = articles.slice(0, count);
    }

    if (!selected.length) {
      if (fromCron) return [];
      throw new UserError(topic
        ? `No hay noticias nuevas de «${TOPICS[topic].label}» en el RSS ahora mismo.`
        : "No hay noticias nuevas en el RSS (todas tienen ya su tweet o son antiguas).");
    }

    const created = [];
    const failures = [];

    for (let i = 0; i < selected.length; i++) {
      const article = selected[i];
      try {
        const withLink = await nextNeedsLink(env, cfg);
        const text = await writeTweet(env, cfg, article, withLink);
        const id = await insertTweet(env, {
          text, mode, articleUrl: article.url, articleTitle: article.title,
          articleSummary: article.description, topic: article.topic
        });
        // Se programa en cuanto se crea, así nunca queda un automático sin hora.
        if (mode === "auto") await scheduleTweets(env, [id]);
        created.push(id);
      } catch (error) {
        failures.push(`${article.title}: ${error.message || error}`);
      }
    }

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

async function rewriteTweet(env, cfg, tweet) {
  const article = { title: tweet.article_title || "", description: tweet.article_summary || "", url: tweet.article_url };
  const text = await writeTweet(env, cfg, article, Boolean(tweet.has_link));
  await env.DB.prepare("UPDATE tweets SET text=?, has_link=?, topic=COALESCE(topic, ?) WHERE id=?")
    .bind(text, hasLink(text) ? 1 : 0, classifyTopic(article.title, article.description), tweet.id).run();
}

// Detección sencilla de español (para avisar de tweets en el idioma equivocado).
function looksSpanish(text) {
  const t = String(text).replace(/https?:\/\/\S+/g, "");
  const hits = (t.match(/\b(el|los|las|del|que|para|tras|según|una|por|con|sus|más|está|han|sobre)\b/gi) || []).length;
  return /[ñ¿¡]/i.test(t) || hits >= 3;
}

// Lleva enlace si desde el último tweet con enlace ya van (linkEvery - 1) sin él.
async function nextNeedsLink(env, cfg) {
  const every = Number(cfg.linkEvery);
  if (!every) return false;
  if (every === 1) return true;
  const lastLinked = await env.DB.prepare(
    "SELECT MAX(id) AS id FROM tweets WHERE article_url IS NOT NULL AND has_link=1"
  ).first();
  const since = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tweets WHERE article_url IS NOT NULL AND id > ?"
  ).bind(Number(lastLinked?.id || 0)).first();
  return Number(since?.n || 0) >= every - 1;
}

async function writeTweet(env, cfg, article, withLink) {
  const maxBody = withLink ? 280 - X_URL_LENGTH - 1 : 280;
  const target = Math.min(240, maxBody - 10);

  const prompt = cfg.language === "es" ? [
    "Escribe UN tweet para la cuenta de X de Noticiero VOID (noticias de mercados, cripto, tecnología e IA).",
    "Reglas:",
    "- Español de España, tono de agencia de noticias: directo, claro y con gancho.",
    "- Si la noticia está en inglés, tradúcela.",
    `- Máximo ${target} caracteres.`,
    "- Usa solo los datos de la noticia. No inventes cifras, fechas ni declaraciones.",
    "- Sin hashtags, sin enlaces, sin emojis y sin comillas alrededor del texto.",
    "- Devuelve solo el texto del tweet, nada más.",
    "",
    `TITULAR: ${article.title}`,
    `RESUMEN: ${(article.description || "").slice(0, 1500) || "(sin resumen)"}`
  ] : [
    "Write ONE tweet for the X account of Noticiero VOID (markets, crypto, tech and AI news).",
    "Rules:",
    "- Write in English, in a sharp newswire style: direct, clear, with a hook.",
    "- If the article is not in English, translate it.",
    `- Maximum ${target} characters.`,
    "- Use only facts from the article. Do not invent numbers, dates or quotes.",
    "- No hashtags, no links, no emojis and no quotation marks around the text.",
    "- Return only the tweet text, nothing else.",
    "",
    `HEADLINE: ${article.title}`,
    `SUMMARY: ${(article.description || "").slice(0, 1500) || "(no summary)"}`
  ];
  const promptText = prompt.join("\n");

  let text = "";
  for (let attempt = 0; attempt < 2 && text.length < 20; attempt++) {
    text = tidyAIText(await askAI(env, cfg.model, promptText, 2000));
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
      { role: "system", content: "You are the social media editor of a financial news outlet. You are rigorous and concise." },
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
    .replace(/^\s*(tweet|texto|text)\s*:\s*/i, "")
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
    if (!found.has(link)) {
      found.set(link, { title, url: link, description, date: Number.isFinite(date) ? date : 0, topic: classifyTopic(title, description) });
    }
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
  const columns = new Set(((await env.DB.prepare("PRAGMA table_info(tweets)").all()).results || []).map(c => c.name));
  for (const [name, type] of [["topic", "TEXT"], ["article_summary", "TEXT"]]) {
    if (!columns.has(name)) await env.DB.prepare(`ALTER TABLE tweets ADD COLUMN ${name} ${type}`).run();
  }
  schemaReady = true;
}

async function getConfig(env) {
  const row = await env.DB.prepare("SELECT value FROM tw_config WHERE key='config'").first();
  let stored = {};
  try { stored = row ? JSON.parse(row.value) : {}; } catch {}
  const cfg = { ...DEFAULT_CONFIG, ...stored };
  cfg.topicPlan = { ...DEFAULT_CONFIG.topicPlan, ...(stored.topicPlan || {}) };
  cfg.maxPerDay = planTotal(cfg.topicPlan); // el máximo diario es la suma del plan
  return cfg;
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

  num("linkEvery", 0, 20);
  num("minMinutesBetween", 0, 600);
  num("windowStart", 0, 23);
  num("windowEnd", 0, 24);
  num("maxArticleAgeHours", 1, 720);
  num("monthlyBudgetEur", 0, 10000);
  num("costPerTweetEur", 0, 10);
  num("costPerLinkTweetEur", 0, 10);

  for (const key of ["windowStart", "windowEnd", "linkEvery"]) {
    if (out[key] !== undefined) out[key] = Math.round(out[key]);
  }

  if (body.language !== undefined) out.language = body.language === "es" ? "es" : "en";

  if (body.topicPlan !== undefined) {
    const plan = {};
    for (const key of Object.keys(TOPICS)) {
      const n = Math.round(Number(body.topicPlan?.[key]) || 0);
      if (n < 0 || n > 50) throw new UserError("Cada tema debe tener entre 0 y 50 tweets.");
      plan[key] = n;
    }
    const total = planTotal(plan);
    if (total < 1 || total > 100) throw new UserError("El plan del día debe sumar entre 1 y 100 tweets.");
    out.topicPlan = plan;
    out.maxPerDay = total;
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

async function getKey(env, key) {
  const row = await env.DB.prepare("SELECT value FROM tw_config WHERE key=?").bind(key).first();
  return row ? row.value : null;
}

async function setKey(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO tw_config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(key, String(value)).run();
}

async function insertTweet(env, { text, mode, articleUrl, articleTitle, articleSummary = null, topic = "other" }) {
  const result = await env.DB.prepare(`
    INSERT INTO tweets(text, mode, status, has_link, article_url, article_title, article_summary, topic, created_at)
    VALUES(?, ?, 'pending', ?, ?, ?, ?, ?, ?)
  `).bind(text, mode, hasLink(text) ? 1 : 0, articleUrl, articleTitle, articleSummary, TOPICS[topic] ? topic : "other", new Date().toISOString()).run();
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
