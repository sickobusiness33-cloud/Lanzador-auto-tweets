// Lanzador de tweets — dos bots en el mismo panel:
//   · Noticiero VOID: lee el RSS de noticierovoid.com y tuitea noticias por temas.
//   · StayLiquid: tuitea las buenas operaciones del bot de stayliquid.tech, noticias de memecoins
//     y cripto de noticierovoid.com, y promoción de la app.
// Cada bot tiene su cuenta de X, su app de X (sus créditos), su plan, su presupuesto y su interruptor.
// Cada tweet es AUTOMÁTICO (sale solo a su hora) o MANUAL (espera a que pulses Publicar).

import { DurableObject } from "cloudflare:workers";
import APP_HTML from "./app.html";

const VERSION = "10.1.1";
const TICK_MS = 60000;
const X_URL_LENGTH = 23; // X cuenta cualquier enlace como 23 caracteres

// ---------------------------------------------------------------------------
// Temas
// El RSS no trae categorías, así que cada noticia se clasifica por palabras clave
// (el titular pesa el triple que el resumen). En empate gana el que va antes en la lista.

const NEWS_TOPICS = {
  crypto: { label: "Cripto", emoji: "🪙", words: ["bitcoin", "btc", "ethereum", "ether", "eth", "crypto", "cryptocurrency", "cryptocurrencies", "solana", "xrp", "ripple", "dogecoin", "stablecoin", "stablecoins", "tether", "usdt", "usdc", "blockchain", "defi", "nft", "nfts", "token", "tokens", "tokenized", "tokenization", "binance", "coinbase", "kraken", "web3", "altcoin", "altcoins", "memecoin", "memecoins", "meme coin", "meme coins", "pump.fun", "satoshi", "digital asset", "digital assets", "wallet", "cz", "saylor", "microstrategy", "on-chain", "onchain"] },
  macro: { label: "Macro y bancos centrales", emoji: "🏦", words: ["fed", "federal reserve", "ecb", "boe", "boj", "central bank", "interest rate", "interest rates", "rate cut", "rate cuts", "rate hike", "inflation", "cpi", "pce", "gdp", "jobs report", "payrolls", "unemployment", "treasury", "treasuries", "yields", "recession", "tariff", "tariffs", "warsh", "powell", "lagarde", "economy", "monetary policy", "dollar", "forex", "currency", "currencies", "euro", "yen"] },
  commodities: { label: "Materias primas", emoji: "🛢️", words: ["oil", "crude", "brent", "wti", "opec", "gold", "silver", "copper", "natural gas", "lng", "coal", "lithium", "uranium", "wheat", "commodity", "commodities", "mine", "mining", "rare earths", "barrel"] },
  ai: { label: "IA y tecnología", emoji: "🤖", words: ["ai", "artificial intelligence", "openai", "chatgpt", "gpt", "nvidia", "gemini", "anthropic", "claude", "copilot", "llm", "chip", "chips", "semiconductor", "semiconductors", "cloud", "cybersecurity", "software", "agent", "agents", "agentic", "robot", "robotics", "quantum", "data center", "google", "alphabet", "microsoft", "apple", "meta", "amazon", "tesla", "github"] },
  stocks: { label: "Acciones y resultados", emoji: "📈", words: ["stock", "stocks", "shares", "earnings", "eps", "revenue", "price target", "upgrade", "upgrades", "downgrade", "downgrades", "ipo", "dividend", "nasdaq", "s&p", "dow", "wall street", "guidance", "buyback", "q1", "q2", "q3", "q4", "quarterly", "beats", "misses", "rally", "market cap", "analyst", "rating", "estimates"] },
  finance: { label: "Finanzas y empresas", emoji: "💼", words: ["bank", "banks", "banking", "fund", "funds", "aum", "etf", "asset manager", "hedge fund", "private equity", "acquisition", "acquires", "merger", "deal", "private placement", "bond", "bonds", "insurer", "insurance", "loan", "loans", "credit", "capital", "venture", "raises", "funding", "capex", "leverage"] },
  politics: { label: "Política y geopolítica", emoji: "🌍", words: ["election", "elections", "midterm", "midterms", "campaign", "governor", "president", "trump", "congress", "senate", "war", "sanctions", "china", "russia", "ukraine", "israel", "iran", "geopolitical", "government", "minister", "parliament", "regulation", "regulators", "sec"] },
  other: { label: "Otros", emoji: "📰", words: [] }
};

// Palabras que convierten una noticia cripto en noticia de memecoins (para StayLiquid).
const MEME_WORDS = ["memecoin", "memecoins", "meme coin", "meme coins", "meme", "memes", "pump.fun", "pumpfun", "pumpswap", "dogecoin", "doge", "shiba", "shib", "pepe", "bonk", "wif", "dogwifhat", "floki", "fartcoin", "popcat", "trump coin", "$trump", "moonshot", "degen"];

const toPatterns = words => words.map(w =>
  new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`, "i"));
const NEWS_PATTERNS = Object.fromEntries(Object.entries(NEWS_TOPICS).map(([k, t]) => [k, toPatterns(t.words)]));
const MEME_PATTERNS = toPatterns(MEME_WORDS);

export function classifyTopic(title, description = "") {
  let best = "other";
  let bestScore = 0;
  for (const [key, patterns] of Object.entries(NEWS_PATTERNS)) {
    let score = 0;
    for (const re of patterns) {
      if (re.test(title)) score += 3;
      else if (re.test(description)) score += 1;
    }
    if (score > bestScore) { best = key; bestScore = score; }
  }
  return best;
}

function isMemeNews(title, description = "") {
  return MEME_PATTERNS.some(re => re.test(title) || re.test(description));
}

// ---------------------------------------------------------------------------
// Bots

const COMMON_DEFAULTS = {
  autopilot: false,            // interruptor del bot: publica los automáticos y prepara tweets nuevos
  newTweetsMode: "auto",       // los tweets que genera la IA: "auto" o "manual"
  linkEvery: 4,                // 1 de cada N tweets lleva enlace (0 = nunca)
  language: "en",              // idioma de los tweets: "en" o "es"
  minMinutesBetween: 45,       // separación mínima entre tweets automáticos
  windowStart: 8,              // hora local a partir de la que se publica
  windowEnd: 23,               // hora local hasta la que se publica
  maxArticleAgeHours: 72,
  monthlyBudgetEur: 16,
  costPerTweetEur: 0.016,
  costPerLinkTweetEur: 0.21,
  rssUrl: "https://noticierovoid.com/rss.xml",
  model: "@cf/zai-org/glm-4.7-flash",
  timezone: "Europe/Madrid",
  xUsername: null
};

const BOTS = {
  void: {
    name: "Noticiero VOID",
    emoji: "📰",
    prefix: "",                       // claves en tw_config: "config", "x_account"... (como antes)
    env: { key: "X_CONSUMER_KEY", secret: "X_CONSUMER_SECRET", token: "X_ACCESS_TOKEN", tokenSecret: "X_ACCESS_TOKEN_SECRET" },
    topics: NEWS_TOPICS,
    defaults: {
      ...COMMON_DEFAULTS,
      topicPlan: { crypto: 4, stocks: 4, macro: 3, ai: 3, commodities: 1, finance: 1, politics: 0, other: 0 }
    }
  },
  stayliquid: {
    name: "StayLiquid",
    emoji: "💧",
    prefix: "stayliquid:",
    env: { key: "SL_X_CONSUMER_KEY", secret: "SL_X_CONSUMER_SECRET", token: "SL_X_ACCESS_TOKEN", tokenSecret: "SL_X_ACCESS_TOKEN_SECRET" },
    topics: {
      trades: { label: "Buenas operaciones del bot", emoji: "🏆" },
      memecoins: { label: "Noticias de memecoins", emoji: "🐸" },
      crypto: { label: "Noticias cripto", emoji: "🪙" },
      promo: { label: "Promoción de StayLiquid", emoji: "📣" }
    },
    defaults: {
      ...COMMON_DEFAULTS,
      monthlyBudgetEur: 10,
      minMinutesBetween: 60,
      topicPlan: { trades: 3, memecoins: 2, crypto: 2, promo: 1 },
      appUrl: "https://stayliquid.tech",
      historyUrl: "https://stayliquid.tech/api/copy/history",
      minTradePct: 15,           // solo tuitea operaciones cerradas con al menos este % de ganancia
      minTradeSol: 0.2           // y con una compra de al menos esto (evita cierres sin coste real)
    }
  }
};

function botOf(id) {
  return BOTS[id] ? id : "void";
}

const configKey = bot => `${BOTS[bot].prefix}config`;
const botKey = (bot, key) => `${BOTS[bot].prefix}${key}`;

function planTotal(bot, plan) {
  return Object.keys(BOTS[bot].topics).reduce((sum, key) => sum + (Number(plan?.[key]) || 0), 0);
}

// ---------------------------------------------------------------------------
// Entrada

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
      let bot = "void";
      try {
        await ensureSchema(env);
        bot = await finishXConnect(env, url);
      } catch (error) {
        console.error("x callback", error);
        result = encodeURIComponent(error.message || String(error));
      }
      return Response.redirect(new URL(`/?x=${result}&bot=${bot}`, url).toString(), 302);
    }

    if (!url.pathname.startsWith("/api/")) return json({ ok: false, error: "No encontrado." }, 404);

    try {
      if (!env.DB) throw new UserError("Falta la base de datos D1 (binding DB).");
      if (!env.ADMIN_TOKEN) throw new UserError("Falta el secreto ADMIN_TOKEN en Cloudflare.");
      if (request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
        return json({ ok: false, error: "Contraseña incorrecta." }, 401);
      }

      await ensureSchema(env);
      return await route(request, url, env, botOf(url.searchParams.get("bot")));
    } catch (error) {
      console.error(error);
      const message = error instanceof UserError ? error.message : `Error interno: ${error.message || error}`;
      if (!(error instanceof UserError)) await log(env, botOf(url.searchParams.get("bot")), "error", message).catch(() => {});
      return json({ ok: false, error: message }, 400);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runAllBots(env));
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
    await runAllBots(this.env);
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

async function runAllBots(env) {
  await ensureSchema(env);
  await recoverStuck(env);
  for (const bot of Object.keys(BOTS)) {
    try {
      await cron(env, bot);
    } catch (error) {
      console.error("tick", bot, error);
      await log(env, bot, "error", `Piloto automático: ${error.message || error}`).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// API (todas las rutas llevan ?bot=void|stayliquid)

async function route(request, url, env, bot) {
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const path = url.pathname;

  if (path === "/api/state" && request.method === "GET") return json(await getState(env, bot));

  if (request.method !== "POST") throw new UserError("Método no permitido.");

  if (path === "/api/autopilot") {
    const cfg = await saveConfig(env, bot, { autopilot: Boolean(body.on) });
    if (body.on) await setKey(env, botKey(bot, "nextGenerationCheck"), 0); // rellena la cola enseguida
    await log(env, bot, body.on ? "ok" : "warn", body.on ? "Bot EN MARCHA." : "Bot PARADO.");
    return json({ ok: true, config: cfg });
  }

  if (path === "/api/config") {
    const cfg = await saveConfig(env, bot, validateConfig(bot, body));
    await log(env, bot, "info", "Ajustes guardados.");
    return json({ ok: true, config: cfg });
  }

  if (path === "/api/generate") {
    const count = clampInt(body.count, 1, 8, 4);
    const mode = body.mode === "manual" ? "manual" : "auto";
    const topic = BOTS[bot].topics[body.topic] ? body.topic : null;
    const created = await generateBatch(env, bot, count, mode, { topic });
    return json({ ok: true, created });
  }

  if (path === "/api/tweets/create") {
    const text = cleanText(body.text);
    checkLength(text);
    const mode = body.mode === "manual" ? "manual" : "auto";
    if (mode === "auto") checkFutureTime(body.scheduledAt);
    const topics = BOTS[bot].topics;
    const topic = topics[body.topic] ? body.topic : (topics.other ? classifyTopic(text) : "promo");
    const id = await insertTweet(env, bot, { text, mode, articleUrl: null, articleTitle: "Escrito a mano", topic });
    if (mode === "auto") await scheduleTweets(env, bot, [id], body.scheduledAt);
    await log(env, bot, "info", `Tweet #${id} escrito a mano (${modeName(mode)}).`);
    return json({ ok: true, id });
  }

  // Rehace con la IA (en el idioma configurado) hasta 3 tweets pendientes que no estén en ese idioma.
  if (path === "/api/rewrite-pending") {
    const cfg = await getConfig(env, bot);
    const rows = await env.DB.prepare(
      "SELECT * FROM tweets WHERE bot=? AND status IN ('pending','error') AND article_url IS NOT NULL ORDER BY scheduled_at IS NULL, scheduled_at, id"
    ).bind(bot).all();
    const todo = (rows.results || []).filter(t => looksSpanish(t.text) !== (cfg.language === "es"));
    let done = 0;
    for (const tweet of todo.slice(0, 3)) {
      await rewriteTweet(env, bot, cfg, tweet);
      done++;
    }
    return json({ ok: true, done, remaining: todo.length - done });
  }

  if (path === "/api/reschedule") {
    const n = await rescheduleAll(env, bot);
    await log(env, bot, "info", `Horarios recalculados para ${n} tweets automáticos.`);
    return json({ ok: true, count: n });
  }

  // Claves de la app de X de este bot (API Key / API Key Secret). Cada app tiene sus propios créditos.
  if (path === "/api/x/app") {
    const key = String(body.key || "").trim();
    const secret = String(body.secret || "").trim();
    if (!key && !secret) {
      await env.DB.prepare("DELETE FROM tw_config WHERE key=?").bind(botKey(bot, "x_app")).run();
      await log(env, bot, "warn", "Claves de la app de X borradas del panel.");
      return json({ ok: true });
    }
    if (!/^[\w-]{10,}$/.test(key) || !/^[\w-]{20,}$/.test(secret)) {
      throw new UserError("Esas claves no parecen válidas. Copia la «API Key» y la «API Key Secret» de tu app en developer.x.com.");
    }
    await setKey(env, botKey(bot, "x_app"), JSON.stringify({ key, secret, savedAt: new Date().toISOString() }));
    await log(env, bot, "ok", "Claves de la app de X guardadas.");
    return json({ ok: true });
  }

  // Access Token + Secret pegados a mano (los genera la consola de X para la cuenta dueña de la app).
  if (path === "/api/x/tokens") {
    const token = String(body.token || "").trim();
    const secret = String(body.secret || "").trim();
    if (!/^\d+-[\w-]{10,}$/.test(token) || !/^[\w-]{20,}$/.test(secret)) {
      throw new UserError("Eso no parece un Access Token válido. Tiene la forma 123456789-AbCd… y el Secret es una cadena larga.");
    }
    if (!await getXApp(env, bot)) throw new UserError(`Primero guarda las claves de la app de X de ${BOTS[bot].name} (API Key y API Key Secret).`);
    const previous = await getKey(env, botKey(bot, "x_account"));
    await setKey(env, botKey(bot, "x_account"), JSON.stringify({ token, secret, connectedAt: new Date().toISOString() }));
    try {
      const me = await xRequest(env, bot, "GET", "https://api.x.com/2/users/me");
      const username = me?.data?.username || null;
      await setKey(env, botKey(bot, "x_account"), JSON.stringify({ token, secret, username, userId: me?.data?.id || null, connectedAt: new Date().toISOString() }));
      await saveConfig(env, bot, { xUsername: username });
      await log(env, bot, "ok", `Cuenta de X conectada con Access Token: @${username}.`);
      return json({ ok: true, username });
    } catch (error) {
      if (previous) await setKey(env, botKey(bot, "x_account"), previous);
      else await env.DB.prepare("DELETE FROM tw_config WHERE key=?").bind(botKey(bot, "x_account")).run();
      throw new UserError(`X no acepta ese Access Token: ${error.message || error}`);
    }
  }

  // Paso 1 del OAuth: pide a X un token temporal y devuelve la página donde el usuario autoriza.
  if (path === "/api/x/connect") {
    const app = await getXApp(env, bot);
    if (!app) throw new UserError(`Primero guarda las claves de la app de X de ${BOTS[bot].name} (API Key y API Key Secret).`);
    const callback = new URL("/x/callback", url).toString();
    const res = await xOAuthStep(app, "https://api.x.com/oauth/request_token", { oauth_callback: callback }, "");
    if (res.get("oauth_callback_confirmed") !== "true") throw new UserError("X no ha aceptado la dirección de vuelta.");
    const token = res.get("oauth_token");
    await env.DB.prepare("DELETE FROM tw_config WHERE key LIKE 'x_request_%'").run(); // solo una conexión pendiente
    await setKey(env, `x_request_${token}`, JSON.stringify({ secret: res.get("oauth_token_secret"), at: Date.now(), bot }));
    return json({ ok: true, url: `https://api.x.com/oauth/authorize?oauth_token=${encodeURIComponent(token)}`, callback });
  }

  if (path === "/api/x/disconnect") {
    await env.DB.prepare("DELETE FROM tw_config WHERE key=?").bind(botKey(bot, "x_account")).run();
    await saveConfig(env, bot, { xUsername: null });
    await log(env, bot, "warn", "Cuenta de X desconectada.");
    return json({ ok: true });
  }

  if (path === "/api/test-x") {
    const me = await xRequest(env, bot, "GET", "https://api.x.com/2/users/me");
    const username = me?.data?.username || null;
    await saveConfig(env, bot, { xUsername: username });
    await log(env, bot, "ok", `Conexión con X correcta: @${username}.`);
    return json({ ok: true, username, name: me?.data?.name || null });
  }

  if (path === "/api/test-ai") {
    const cfg = await getConfig(env, bot);
    const text = await askAI(env, cfg.model, "Reply only with this sentence: The AI is working.", 1000);
    return json({ ok: true, model: cfg.model, text });
  }

  const match = path.match(/^\/api\/tweets\/(\d+)\/(edit|mode|publish|retry|delete|rewrite)$/);
  if (match) return json(await tweetAction(env, bot, Number(match[1]), match[2], body));

  throw new UserError("Ruta no encontrada.");
}

async function tweetAction(env, bot, id, action, body) {
  const tweet = await env.DB.prepare("SELECT * FROM tweets WHERE id=? AND bot=?").bind(id, bot).first();
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
    if (mode === "auto") await scheduleTweets(env, bot, [id], body.scheduledAt);
    await log(env, bot, "info", `Tweet #${id} pasado a ${modeName(mode)}.`);
    return { ok: true };
  }

  if (action === "rewrite") {
    if (!tweet.article_url) throw new UserError("Este tweet está escrito a mano: edítalo tú.");
    await rewriteTweet(env, bot, await getConfig(env, bot), tweet);
    return { ok: true };
  }

  if (action === "retry") {
    await env.DB.prepare("UPDATE tweets SET status='pending', error=NULL, scheduled_at=NULL WHERE id=?").bind(id).run();
    if (tweet.mode === "auto") await scheduleTweets(env, bot, [id]);
    return { ok: true };
  }

  if (action === "delete") {
    await env.DB.prepare("DELETE FROM tweets WHERE id=?").bind(id).run();
    return { ok: true };
  }
}

async function getState(env, bot) {
  const cfg = await getConfig(env, bot);
  await recoverStuck(env);

  const [pending, published, errors, logRows] = await Promise.all([
    env.DB.prepare("SELECT * FROM tweets WHERE bot=? AND status IN ('pending','sending') ORDER BY scheduled_at IS NULL, scheduled_at, created_at").bind(bot).all(),
    env.DB.prepare("SELECT * FROM tweets WHERE bot=? AND status='published' ORDER BY published_at DESC LIMIT 60").bind(bot).all(),
    env.DB.prepare("SELECT * FROM tweets WHERE bot=? AND status='error' ORDER BY created_at DESC LIMIT 60").bind(bot).all(),
    env.DB.prepare("SELECT * FROM tw_log WHERE bot=? ORDER BY id DESC LIMIT 80").bind(bot).all()
  ]);

  const rows = pending.results || [];
  const now = new Date();
  const creds = await xCredsStatus(env, bot);

  // Estado de los dos bots, para el selector de arriba.
  const bots = {};
  for (const [id, b] of Object.entries(BOTS)) {
    const c = id === bot ? cfg : await getConfig(env, id);
    bots[id] = { name: b.name, emoji: b.emoji, autopilot: c.autopilot, xUsername: c.xUsername };
  }

  return {
    ok: true,
    version: VERSION,
    now: now.toISOString(),
    bot,
    bots,
    config: cfg,
    stats: await getStats(env, bot, cfg, now),
    clock: await tickerStatus(env),
    xAccount: creds.account,
    xApp: creds.app,
    secrets: { x: creds.missing, ai: Boolean(env.AI) },
    topics: Object.fromEntries(Object.entries(BOTS[bot].topics).map(([k, t]) => [k, { label: t.label, emoji: t.emoji }])),
    prepared: countByTopic(bot, rows.filter(t => t.mode === cfg.newTweetsMode)),
    auto: rows.filter(t => t.mode === "auto"),
    manual: rows.filter(t => t.mode === "manual"),
    published: published.results || [],
    errors: errors.results || [],
    log: logRows.results || []
  };
}

function countByTopic(bot, rows) {
  const topics = BOTS[bot].topics;
  const fallback = topics.other ? "other" : Object.keys(topics)[0];
  const out = Object.fromEntries(Object.keys(topics).map(k => [k, 0]));
  for (const t of rows) out[topics[t.topic] ? t.topic : fallback]++;
  return out;
}

async function getStats(env, bot, cfg, now) {
  const today = localDate(now, cfg.timezone);
  const month = today.slice(0, 7);
  const recent = await env.DB.prepare(
    "SELECT published_at, cost_eur FROM tweets WHERE bot=? AND status='published' AND published_at >= ?"
  ).bind(bot, new Date(now.getTime() - 32 * 86400000).toISOString()).all();

  let publishedToday = 0;
  let spentMonth = 0;
  for (const row of recent.results || []) {
    const day = localDate(new Date(row.published_at), cfg.timezone);
    if (day === today) publishedToday++;
    if (day.slice(0, 7) === month) spentMonth += Number(row.cost_eur || 0);
  }

  const next = await env.DB.prepare(
    "SELECT id, scheduled_at FROM tweets WHERE bot=? AND status='pending' AND mode='auto' ORDER BY scheduled_at LIMIT 1"
  ).bind(bot).first();
  const next24 = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tweets WHERE bot=? AND status='pending' AND mode='auto' AND scheduled_at <= ?"
  ).bind(bot, new Date(now.getTime() + 86400000).toISOString()).first();

  return {
    publishedToday,
    spentMonth: Math.round(spentMonth * 100) / 100,
    nextAutoAt: next?.scheduled_at || null,
    queued24h: Number(next24?.n || 0)
  };
}

// ---------------------------------------------------------------------------
// Piloto automático (cada minuto, para cada bot)

async function cron(env, bot) {
  const cfg = await getConfig(env, bot);
  if (!cfg.autopilot) return;

  await fixUnscheduled(env, bot);
  await publishDue(env, bot, cfg);

  // Mantiene la cola llena según el plan del día. Genera de 4 en 4 para que cada vuelta sea corta.
  const nextCheck = Number(await getKey(env, botKey(bot, "nextGenerationCheck"))) || 0;
  if (Date.now() < nextCheck) return;

  const queued = await env.DB.prepare(
    "SELECT topic FROM tweets WHERE bot=? AND status='pending' AND mode=?"
  ).bind(bot, cfg.newTweetsMode).all();
  const have = countByTopic(bot, queued.results || []);
  const quota = {};
  let missing = 0;
  for (const key of Object.keys(BOTS[bot].topics)) {
    quota[key] = Math.max(0, (Number(cfg.topicPlan?.[key]) || 0) - have[key]);
    missing += quota[key];
  }
  if (missing <= 0) return;

  let wait = 20 * 60000;
  try {
    const created = await generateBatch(env, bot, Math.min(4, missing), cfg.newTweetsMode, { fromCron: true, quota });
    if (created === null) return;            // otra vuelta ya está generando
    if (created.length) wait = 60000;        // hay material: sigue llenando en el siguiente minuto
  } finally {
    await setKey(env, botKey(bot, "nextGenerationCheck"), Date.now() + wait);
  }
}

// Un automático sin hora (por ejemplo si una vuelta se cortó) recibe el siguiente hueco libre.
async function fixUnscheduled(env, bot) {
  const rows = await env.DB.prepare(
    "SELECT id FROM tweets WHERE bot=? AND status='pending' AND mode='auto' AND scheduled_at IS NULL ORDER BY id"
  ).bind(bot).all();
  const ids = (rows.results || []).map(r => r.id);
  if (ids.length) await scheduleTweets(env, bot, ids);
}

async function publishDue(env, bot, cfg) {
  const now = new Date();
  if (!inWindow(now, cfg)) return;

  const lastPub = await env.DB.prepare(
    "SELECT published_at FROM tweets WHERE bot=? AND status='published' ORDER BY published_at DESC LIMIT 1"
  ).bind(bot).first();
  if (lastPub && now - Date.parse(lastPub.published_at) < cfg.minMinutesBetween * 60000) return;

  const stats = await getStats(env, bot, cfg, now);
  if (stats.publishedToday >= cfg.maxPerDay) return;

  const due = await env.DB.prepare(
    "SELECT * FROM tweets WHERE bot=? AND status='pending' AND mode='auto' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 1"
  ).bind(bot, now.toISOString()).first();
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
  const bot = botOf(tweet.bot);
  const cfg = await getConfig(env, bot);

  // Red de seguridad para los tweets de la IA: ningún dominio suelto se publica como enlace de pago.
  if (tweet.article_url) {
    const clean = stripBareDomains(tweet.text);
    if (clean !== tweet.text) {
      await env.DB.prepare("UPDATE tweets SET text=?, has_link=? WHERE id=?").bind(clean, hasLink(clean) ? 1 : 0, tweet.id).run();
      tweet = { ...tweet, text: clean, has_link: hasLink(clean) ? 1 : 0 };
    }
  }
  checkLength(tweet.text);

  const cost = tweet.has_link ? cfg.costPerLinkTweetEur : cfg.costPerTweetEur;
  const stats = await getStats(env, bot, cfg, new Date());
  if (stats.spentMonth + cost > cfg.monthlyBudgetEur) {
    const message = `Presupuesto del mes agotado (${stats.spentMonth.toFixed(2)} € de ${cfg.monthlyBudgetEur} €). Súbelo en Ajustes.`;
    if (!manual) await log(env, bot, "warn", message);
    throw new UserError(message);
  }

  // Cambio atómico: solo una ejecución puede pasar el tweet a "sending".
  const claim = await env.DB.prepare(
    "UPDATE tweets SET status='sending', sending_at=?, error=NULL WHERE id=? AND status IN ('pending','error')"
  ).bind(new Date().toISOString(), tweet.id).run();
  if (!claim.meta.changes) throw new UserError("Este tweet ya se está enviando.");

  try {
    const result = await xRequest(env, bot, "POST", "https://api.x.com/2/tweets", { text: tweet.text });
    const xId = result?.data?.id || null;
    await env.DB.prepare(
      "UPDATE tweets SET status='published', x_post_id=?, published_at=?, cost_eur=?, error=NULL WHERE id=?"
    ).bind(xId, new Date().toISOString(), cost, tweet.id).run();
    await log(env, bot, "ok", `Tweet #${tweet.id} publicado en X${manual ? " (a mano)" : " (automático)"}.`);
    return { xPostId: xId };
  } catch (error) {
    const message = error.message || String(error);
    await env.DB.prepare("UPDATE tweets SET status='error', error=? WHERE id=?").bind(message, tweet.id).run();
    await log(env, bot, "error", `Tweet #${tweet.id} no se pudo publicar: ${message}`);
    if (error.status === 402) {
      await saveConfig(env, bot, { autopilot: false });
      await log(env, bot, "warn", "Bot parado: X dice que no quedan créditos.");
    }
    throw new UserError(message);
  }
}

// App de X del bot (sus créditos): la guardada en el panel o, si no hay, la de los secretos de Cloudflare.
async function getXApp(env, bot) {
  try {
    const stored = JSON.parse(await getKey(env, botKey(bot, "x_app")) || "null");
    if (stored?.key && stored?.secret) return { key: stored.key, secret: stored.secret, source: "panel" };
  } catch {}
  const e = BOTS[bot].env;
  if (env[e.key] && env[e.secret]) return { key: env[e.key], secret: env[e.secret], source: "cloudflare" };
  return null;
}

// Cuenta en la que publica el bot: la conectada desde el panel o, si no hay, la de los secretos.
async function getXAccount(env, bot) {
  try {
    const stored = JSON.parse(await getKey(env, botKey(bot, "x_account")) || "null");
    if (stored?.token && stored?.secret) return { ...stored, source: "panel" };
  } catch {}
  const e = BOTS[bot].env;
  if (env[e.token] && env[e.tokenSecret]) return { token: env[e.token], secret: env[e.tokenSecret], source: "cloudflare" };
  return null;
}

async function xCredsStatus(env, bot) {
  const app = await getXApp(env, bot);
  const account = await getXAccount(env, bot);
  const missing = [];
  if (!app) missing.push("claves de la app de X");
  if (!account) missing.push("cuenta de X conectada");
  return {
    missing,
    app: app ? { source: app.source, keyHint: `${app.key.slice(0, 4)}…${app.key.slice(-3)}` } : { source: "none" },
    account: account
      ? { source: account.source, username: account.username || null, connectedAt: account.connectedAt || null }
      : { source: "none", username: null }
  };
}

async function xRequest(env, bot, method, endpoint, payload) {
  const app = await getXApp(env, bot);
  const account = await getXAccount(env, bot);
  if (!app) throw new UserError(`Faltan las claves de la app de X de ${BOTS[bot].name}. Ponlas en Ajustes.`);
  if (!account) throw new UserError(`${BOTS[bot].name} no tiene cuenta de X conectada. Pulsa «Conectar cuenta de X» en Ajustes.`);

  const response = await fetch(endpoint, {
    method,
    headers: {
      authorization: await oauthHeader(app, method, endpoint, { oauth_token: account.token }, account.secret),
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
  if (/^\s*</.test(body)) {
    return status >= 500
      ? `X ha fallado por su lado (${status}). Vuelve a intentarlo en un rato o usa el Access Token de la consola de X.`
      : `X respondió ${status} con una página de error.`;
  }
  const raw = body.slice(0, 400);
  const lower = body.toLowerCase();
  if (status === 401) return "X rechaza las claves (401). Revisa las claves de la app y vuelve a conectar la cuenta de X.";
  if (status === 403 && lower.includes("duplicate")) return "X no deja publicar un tweet repetido. Cambia el texto.";
  if (status === 403 && (lower.includes("oauth1-permissions") || lower.includes("not permitted") || lower.includes("permission"))) {
    return "La app de X no tiene permiso de ESCRITURA. En developer.x.com → tu app → User authentication settings pon «Read and write» y vuelve a conectar la cuenta.";
  }
  if (status === 403) return `X ha bloqueado la publicación (403): ${raw}`;
  if (status === 402) return "La app de X no tiene créditos (402). Recarga en developer.x.com.";
  if (status === 429) return "X dice que vas demasiado rápido (429). Se reintentará más tarde.";
  return `X respondió ${status}: ${raw}`;
}

// Firma OAuth 1.0a (HMAC-SHA1). `extra` añade parámetros oauth_* (token, callback, verifier).
async function oauthHeader(app, method, endpoint, extra, tokenSecret) {
  const enc = value => encodeURIComponent(String(value))
    .replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());

  const oauth = {
    oauth_consumer_key: app.key,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...extra
  };

  // El cuerpo JSON no entra en la firma; solo los parámetros oauth (el endpoint no lleva query).
  const params = Object.keys(oauth).sort().map(k => `${enc(k)}=${enc(oauth[k])}`).join("&");
  const base = [method.toUpperCase(), enc(endpoint), enc(params)].join("&");
  const signingKey = `${enc(app.secret)}&${enc(tokenSecret || "")}`;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(signingKey), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base)));
  oauth.oauth_signature = btoa(String.fromCharCode(...signature));

  return "OAuth " + Object.keys(oauth).sort().map(k => `${enc(k)}="${enc(oauth[k])}"`).join(", ");
}

// Pasos 1 y 3 del OAuth de 3 patas: X responde con un formulario (a=1&b=2), no con JSON.
async function xOAuthStep(app, endpoint, extra, tokenSecret) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: await oauthHeader(app, "POST", endpoint, extra, tokenSecret) },
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 && /callback/i.test(text)) {
      throw new UserError("X no reconoce la dirección de vuelta. Pon la «Callback URI» que sale en el panel en developer.x.com → tu app → User authentication settings.");
    }
    const error = new UserError(explainXError(response.status, text));
    error.status = response.status;
    throw error;
  }
  return new URLSearchParams(text);
}

// Devuelve el bot al que se ha conectado la cuenta.
async function finishXConnect(env, url) {
  if (url.searchParams.get("denied")) throw new Error("Has cancelado la autorización en X.");
  const token = url.searchParams.get("oauth_token");
  const verifier = url.searchParams.get("oauth_verifier");
  if (!token || !verifier) throw new Error("X no ha devuelto los datos de la autorización.");

  const key = `x_request_${token}`;
  const pending = JSON.parse(await getKey(env, key) || "null");
  await env.DB.prepare("DELETE FROM tw_config WHERE key=?").bind(key).run();
  if (!pending || Date.now() - pending.at > 15 * 60000) throw new Error("La autorización ha caducado. Vuelve a pulsar «Conectar cuenta de X».");

  const bot = botOf(pending.bot);
  const app = await getXApp(env, bot);
  if (!app) throw new Error("Faltan las claves de la app de X de este bot.");
  // X a veces responde 500 en api.x.com: se reintenta en su dirección antigua.
  let res;
  try {
    res = await xOAuthStep(app, "https://api.x.com/oauth/access_token",
      { oauth_token: token, oauth_verifier: verifier }, pending.secret);
  } catch (error) {
    if (!(error.status >= 500)) throw error;
    res = await xOAuthStep(app, "https://api.twitter.com/oauth/access_token",
      { oauth_token: token, oauth_verifier: verifier }, pending.secret);
  }
  const account = {
    token: res.get("oauth_token"),
    secret: res.get("oauth_token_secret"),
    userId: res.get("user_id"),
    username: res.get("screen_name"),
    connectedAt: new Date().toISOString()
  };
  if (!account.token || !account.secret) throw new Error("X no ha devuelto las claves de la cuenta.");

  await setKey(env, botKey(bot, "x_account"), JSON.stringify(account));
  await saveConfig(env, bot, { xUsername: account.username });
  await log(env, bot, "ok", `Cuenta de X conectada: @${account.username}. ${BOTS[bot].name} publicará en ella.`);
  return bot;
}

// ---------------------------------------------------------------------------
// Material para los tweets
// Cada elemento: { topic, title, description, url, key (para no repetir), facts? }

async function collectMaterial(env, bot, cfg, topicFilter) {
  const wants = t => !topicFilter || topicFilter === t;
  let items = [];

  if (bot === "void") {
    items = (await fetchArticles(env, cfg)).map(a => ({ ...a, key: a.url, topic: classifyTopic(a.title, a.description) }));
  } else {
    if (wants("memecoins") || wants("crypto")) {
      for (const a of await fetchArticles(env, cfg)) {
        if (classifyTopic(a.title, a.description) !== "crypto") continue;
        items.push({ ...a, key: a.url, topic: isMemeNews(a.title, a.description) ? "memecoins" : "crypto" });
      }
    }
    if (wants("trades")) {
      try {
        items.push(...await fetchWinningTrades(env, bot, cfg));
      } catch (error) {
        await log(env, bot, "warn", `No se pudieron leer las operaciones de stayliquid.tech: ${error.message || error}`);
      }
    }
    if (wants("promo")) items.push(...await promoItems(env, bot, cfg));
  }

  return topicFilter ? items.filter(i => i.topic === topicFilter) : items;
}

// Operaciones cerradas con ganancia del bot de StayLiquid (historial público de stayliquid.tech).
async function fetchWinningTrades(env, bot, cfg) {
  const history = await fetchStayLiquidHistory(cfg);
  const closes = computeCloses(history.items || []);
  const since = Date.now() - cfg.maxArticleAgeHours * 3600000;
  const wins = closes
    .filter(c => c.closeAt >= since && c.cost >= cfg.minTradeSol && c.pct >= cfg.minTradePct && c.pct < 5000)
    .sort((a, b) => b.closeAt - a.closeAt);
  if (!wins.length) return [];

  const keys = wins.map(c => `stayliquid:trade:${c.sig}`);
  const used = await usedKeys(env, bot, keys);
  return wins.filter(c => !used.has(`stayliquid:trade:${c.sig}`)).map(c => ({
    topic: "trades",
    key: `stayliquid:trade:${c.sig}`,
    url: cfg.appUrl,
    title: `StayLiquid bot closed a +${c.pct.toFixed(1)}% trade`,
    description: "",
    facts: [
      `Profit: +${c.profit.toFixed(3)} SOL (+${c.pct.toFixed(1)}%)`,
      `Entry: ${c.cost.toFixed(3)} SOL, exit: ${c.proceeds.toFixed(3)} SOL`,
      `Time in the trade: ${formatDuration(c.closeAt - c.openAt)}`,
      `Market: ${c.venue === "pump" ? "Pump fun memecoin" : "Solana memecoin"} (token ${c.mint.slice(0, 4)}…${c.mint.slice(-4)})`
    ]
  }));
}

async function fetchStayLiquidHistory(cfg) {
  const response = await fetch(cfg.historyUrl, {
    headers: { accept: "application/json", "user-agent": `VOID-Lanzador/${VERSION}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// Junta compras y ventas por token: una posición se cierra cuando se vende el 100 %.
export function computeCloses(items) {
  const open = new Map();
  const closes = [];
  for (const t of [...items].sort((a, b) => a.at - b.at)) {
    if (!t.mint || !Number.isFinite(t.sol)) continue;
    const pos = open.get(t.mint) || { cost: 0, proceeds: 0, openAt: t.at };
    if (t.side === "buy") {
      if (!pos.cost && !pos.proceeds) pos.openAt = t.at;
      pos.cost += t.sol;
      open.set(t.mint, pos);
    } else if (t.side === "sell") {
      pos.proceeds += t.sol;
      if (Number(t.sellFrac) >= 1) {
        if (pos.cost > 0) {
          const profit = pos.proceeds - pos.cost;
          closes.push({
            mint: t.mint, sig: t.sig, venue: t.venue, cost: pos.cost, proceeds: pos.proceeds,
            profit, pct: (profit / pos.cost) * 100, openAt: pos.openAt, closeAt: t.at
          });
        }
        open.delete(t.mint);
      } else {
        open.set(t.mint, pos);
      }
    }
  }
  return closes;
}

// Tweets de promoción: hechos de la app y estadísticas en vivo. Siempre llevan enlace a la web.
async function promoItems(env, bot, cfg) {
  // Solo cifras de operaciones concretas (coinciden con la web); los totales los calcula la web a su manera.
  let live = "";
  try {
    const since = Date.now() - 7 * 86400000;
    const best = computeCloses((await fetchStayLiquidHistory(cfg)).items || [])
      .filter(c => c.closeAt >= since && c.cost >= cfg.minTradeSol && c.pct < 5000)
      .sort((a, b) => b.pct - a.pct)[0];
    if (best && best.pct > 0) live = `Best trade of the bot this week: +${best.pct.toFixed(1)}% (+${best.profit.toFixed(3)} SOL) in ${formatDuration(best.closeAt - best.openAt)}.`;
  } catch {}
  const recent = await env.DB.prepare(
    "SELECT text FROM tweets WHERE bot=? AND topic='promo' ORDER BY id DESC LIMIT 5"
  ).bind(bot).all();
  const angles = [
    "Explain what StayLiquid is in one punchy line and invite people to watch the bot trade live.",
    "Highlight that it is non-custodial: you copy each trade signing it in your own wallet; StayLiquid never holds your funds.",
    "Use the best trade of the week to show what the bot can do (only the given numbers).",
    "Mention the live terminal: every buy and sell of the bot appears on-chain in real time, fully transparent.",
    "Invite memecoin traders on Solana to follow the bot and copy it with their own limits (stop loss, take profit)."
  ];
  return angles.map((angle, i) => ({
    topic: "promo",
    key: `stayliquid:promo:${Date.now()}:${i}`,
    url: cfg.appUrl,
    alwaysLink: true,
    title: "StayLiquid promo",
    description: "",
    facts: [
      "StayLiquid is a copy-trading bot for Solana memecoins (pump.fun).",
      "You follow the bot's trades live and copy each one by signing it in your own wallet (Phantom, Brave Wallet).",
      "Non-custodial: StayLiquid never signs for you and never holds your funds.",
      "Live terminal with every on-chain buy and sell, stats, win rate and PnL.",
      live,
      `Angle for this tweet: ${angle}`,
      recent.results?.length ? `Do NOT repeat these previous promo tweets: ${recent.results.map(r => r.text).join(" || ").slice(0, 900)}` : ""
    ].filter(Boolean)
  }));
}

// ---------------------------------------------------------------------------
// Generar tweets con IA

async function generateBatch(env, bot, count, mode, { fromCron = false, topic = null, quota = null } = {}) {
  const lock = await acquireLock(env, `generate:${bot}`, 600);
  if (!lock) {
    if (fromCron) return null;
    throw new UserError("Ya se están generando tweets. Espera un momento.");
  }

  try {
    const cfg = await getConfig(env, bot);
    const items = await collectMaterial(env, bot, cfg, topic);

    // Con plan diario: solo coge material de los temas a los que aún les faltan tweets.
    let selected = [];
    if (quota) {
      const left = { ...quota };
      for (const item of items) {
        if (selected.length >= count) break;
        if (left[item.topic] > 0) { selected.push(item); left[item.topic]--; }
      }
    } else {
      selected = items.slice(0, count);
    }

    if (!selected.length) {
      if (fromCron) return [];
      const topics = BOTS[bot].topics;
      throw new UserError(topic
        ? `No hay material nuevo de «${topics[topic].label}» ahora mismo.`
        : "No hay material nuevo ahora mismo (las noticias ya tienen su tweet o son antiguas).");
    }

    const created = [];
    const failures = [];

    for (const item of selected) {
      try {
        const withLink = item.alwaysLink || await nextNeedsLink(env, bot, cfg);
        const text = await writeTweet(env, bot, cfg, item, withLink);
        const id = await insertTweet(env, bot, {
          text, mode, articleUrl: item.key, articleTitle: item.title,
          articleSummary: item.facts ? item.facts.join("\n") : item.description,
          topic: item.topic, linkUrl: item.url
        });
        // Se programa en cuanto se crea, así nunca queda un automático sin hora.
        if (mode === "auto") await scheduleTweets(env, bot, [id]);
        created.push(id);
      } catch (error) {
        failures.push(`${item.title}: ${error.message || error}`);
      }
    }

    if (created.length) await log(env, bot, "ok", `${created.length} tweets nuevos creados como ${modeName(mode)}.`);
    if (failures.length) await log(env, bot, "error", `La IA falló en ${failures.length}: ${failures.join(" | ").slice(0, 900)}`);
    if (!created.length) throw new UserError("La IA no pudo redactar ningún tweet. Mira la pestaña Actividad.");

    return created;
  } finally {
    await releaseLock(env, `generate:${bot}`, lock);
  }
}

async function rewriteTweet(env, bot, cfg, tweet) {
  const isNews = /^https?:\/\//.test(tweet.article_url);
  const item = {
    topic: tweet.topic,
    title: tweet.article_title || "",
    url: tweet.link_url || (isNews ? tweet.article_url : BOTS[bot].defaults.appUrl),
    description: isNews ? (tweet.article_summary || "") : "",
    facts: isNews ? null : String(tweet.article_summary || "").split("\n").filter(Boolean)
  };
  const text = await writeTweet(env, bot, cfg, item, Boolean(tweet.has_link));
  await env.DB.prepare("UPDATE tweets SET text=?, has_link=? WHERE id=?")
    .bind(text, hasLink(text) ? 1 : 0, tweet.id).run();
}

// Detección sencilla de español (para avisar de tweets en el idioma equivocado).
function looksSpanish(text) {
  const t = String(text).replace(/https?:\/\/\S+/g, "");
  const hits = (t.match(/\b(el|los|las|del|que|para|tras|según|una|por|con|sus|más|está|han|sobre)\b/gi) || []).length;
  return /[ñ¿¡]/i.test(t) || hits >= 3;
}

// Lleva enlace si desde el último tweet con enlace ya van (linkEvery - 1) sin él.
async function nextNeedsLink(env, bot, cfg) {
  const every = Number(cfg.linkEvery);
  if (!every) return false;
  if (every === 1) return true;
  const lastLinked = await env.DB.prepare(
    "SELECT MAX(id) AS id FROM tweets WHERE bot=? AND article_url IS NOT NULL AND has_link=1"
  ).bind(bot).first();
  const since = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tweets WHERE bot=? AND article_url IS NOT NULL AND id > ?"
  ).bind(bot, Number(lastLinked?.id || 0)).first();
  return Number(since?.n || 0) >= every - 1;
}

function buildPrompt(bot, cfg, item, target) {
  const es = cfg.language === "es";
  const langRule = es
    ? "- Escribe en español de España."
    : "- Write in English. If the source is not in English, translate it.";
  const common = [
    langRule,
    `- Maximum ${target} characters.`,
    "- Use only the facts given. Do not invent numbers, dates, names or quotes.",
    "- No hashtags, no links, no web addresses or domain names (write \"Pump fun\", never \"pump.fun\"), and no quotation marks around the text.",
    "- Return only the tweet text, nothing else."
  ];

  if (bot === "void") {
    return [
      "Write ONE tweet for the X account of Noticiero VOID (markets, crypto, tech and AI news).",
      "Rules:",
      "- Sharp newswire style: direct, clear, with a hook. No emojis.",
      ...common,
      "",
      `HEADLINE: ${item.title}`,
      `SUMMARY: ${(item.description || "").slice(0, 1500) || "(no summary)"}`
    ].join("\n");
  }

  const voice = "- Voice: confident crypto-native trader, punchy and fun but credible. At most one emoji.";
  const noPromises = "- Never promise profits or guaranteed returns. Past results are not a guarantee.";
  if (item.topic === "trades") {
    return [
      "Write ONE tweet for StayLiquid's X account celebrating a winning trade just closed by the StayLiquid trading bot (a copy-trading bot for Solana memecoins).",
      "Rules:", voice, noPromises,
      "- Lead with the result (percentage and SOL). Invite people to follow the bot live.",
      ...common, "", "FACTS:", ...item.facts.map(f => `- ${f}`)
    ].join("\n");
  }
  if (item.topic === "promo") {
    return [
      "Write ONE promotional tweet for StayLiquid, a copy-trading bot for Solana memecoins.",
      "Rules:", voice, noPromises,
      "- Make people curious to check the app. Do not write the web address: it is added automatically.",
      ...common, "", "FACTS:", ...item.facts.map(f => `- ${f}`)
    ].join("\n");
  }
  return [
    `Write ONE tweet for StayLiquid's X account (a Solana memecoin copy-trading bot) sharing this ${item.topic === "memecoins" ? "memecoin" : "crypto"} news.`,
    "Rules:", voice,
    "- Newsy and fast: what happened and why traders should care.",
    ...common, "",
    `HEADLINE: ${item.title}`,
    `SUMMARY: ${(item.description || "").slice(0, 1500) || "(no summary)"}`
  ].join("\n");
}

async function writeTweet(env, bot, cfg, item, withLink) {
  const maxBody = withLink ? 280 - X_URL_LENGTH - 1 : 280;
  const target = Math.min(240, maxBody - 10);
  const prompt = buildPrompt(bot, cfg, item, target);

  let text = "";
  for (let attempt = 0; attempt < 2 && text.length < 20; attempt++) {
    text = tidyAIText(await askAI(env, cfg.model, prompt, 2000));
  }
  if (text.length < 20) throw new Error("respuesta vacía de la IA");
  text = stripBareDomains(text);

  if (text.length > maxBody) {
    const cut = text.slice(0, maxBody - 1);
    text = cut.slice(0, Math.max(cut.lastIndexOf(" "), maxBody - 30)).trimEnd() + "…";
  }

  return withLink && item.url ? `${text}\n${item.url}` : text;
}

async function askAI(env, model, prompt, maxTokens) {
  if (!env.AI) throw new UserError("Falta el binding de Workers AI (AI).");
  const result = await env.AI.run(model, {
    messages: [
      { role: "system", content: "You are the social media editor of a crypto and financial news brand. You are rigorous and concise." },
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
    .replace(/\bstayliquid\.tech\S*/gi, "StayLiquid")
    .replace(/\bpump\.fun\b/gi, "Pump fun")
    .replace(/#\w+/g, "")
    .replace(/^\s*(tweet|texto|text)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”«»]+|["'“”«»]+$/g, "")
    .trim();
}

function formatDuration(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ${min % 60} min` : `${Math.round(h / 24)} days`;
}

// ---------------------------------------------------------------------------
// RSS

// El RSS de noticierovoid.com se pide directamente al worker «noticiero-void» (binding NOTICIERO):
// así no depende del dominio público ni de su certificado SSL. Si falla, se usa Internet.
async function fetchRss(env, rssUrl) {
  const init = {
    headers: { "user-agent": `VOID-Lanzador/${VERSION}`, accept: "application/rss+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(15000)
  };
  if (env.NOTICIERO && /(^|\.)noticierovoid\.com$/i.test(new URL(rssUrl).hostname)) {
    try {
      const response = await env.NOTICIERO.fetch(new Request(rssUrl, init));
      if (response.ok) return response;
    } catch (error) {
      console.error("rss binding", error);
    }
  }
  return fetch(rssUrl, init);
}

async function fetchArticles(env, cfg) {
  const response = await fetchRss(env, cfg.rssUrl);
  if (!response.ok) throw new UserError(`No se pudo leer el RSS (${response.status}${response.status === 526 ? ": el certificado SSL de la web está roto" : ""}).`);

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
  const used = await usedKeys(env, cfg.bot, links);
  return [...found.values()].filter(a => !used.has(a.url)).sort((a, b) => b.date - a.date);
}

// Claves (enlaces de noticias, operaciones...) que este bot ya ha usado para un tweet.
async function usedKeys(env, bot, keys) {
  const used = new Set();
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const rows = await env.DB.prepare(
      `SELECT article_url FROM tweets WHERE bot=? AND article_url IN (${chunk.map(() => "?").join(",")})`
    ).bind(bot, ...chunk).all();
    for (const row of rows.results || []) used.add(row.article_url);
  }
  return used;
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

async function scheduleTweets(env, bot, ids, exactAt) {
  const cfg = await getConfig(env, bot);

  if (exactAt) {
    const when = checkFutureTime(exactAt);
    for (const id of ids) {
      await env.DB.prepare("UPDATE tweets SET scheduled_at=? WHERE id=?").bind(new Date(when).toISOString(), id).run();
    }
    return;
  }

  const slots = await nextSlots(env, bot, cfg, ids.length, ids);
  for (let i = 0; i < ids.length; i++) {
    await env.DB.prepare("UPDATE tweets SET scheduled_at=? WHERE id=?").bind(slots[i].toISOString(), ids[i]).run();
  }
}

async function rescheduleAll(env, bot) {
  const rows = await env.DB.prepare(
    "SELECT id FROM tweets WHERE bot=? AND status='pending' AND mode='auto' ORDER BY scheduled_at, created_at"
  ).bind(bot).all();
  const ids = (rows.results || []).map(r => r.id);
  if (!ids.length) return 0;
  const cfg = await getConfig(env, bot);
  const slots = await nextSlots(env, bot, cfg, ids.length, ids);
  for (let i = 0; i < ids.length; i++) {
    await env.DB.prepare("UPDATE tweets SET scheduled_at=? WHERE id=?").bind(slots[i].toISOString(), ids[i]).run();
  }
  return ids.length;
}

// Busca huecos respetando: horario de publicación, separación mínima y máximo diario (de este bot).
async function nextSlots(env, bot, cfg, count, excludeIds = []) {
  const now = Date.now();
  const rows = await env.DB.prepare(`
    SELECT id, COALESCE(published_at, scheduled_at) AS at FROM tweets
    WHERE bot=? AND ((status='published' AND published_at >= ?)
       OR (status IN ('pending','sending') AND mode='auto' AND scheduled_at IS NOT NULL))
  `).bind(bot, new Date(now - 2 * 86400000).toISOString()).all();

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
// Tablas: tweets, tw_config, tw_log, tw_locks. Cada tweet y cada línea de actividad lleva su bot.
// Las tablas de versiones antiguas (posts, settings, events...) se dejan intactas y no se usan.

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
  await addColumns(env, "tweets", [
    ["topic", "TEXT"], ["article_summary", "TEXT"], ["link_url", "TEXT"], ["bot", "TEXT NOT NULL DEFAULT 'void'"]
  ]);
  await addColumns(env, "tw_log", [["bot", "TEXT NOT NULL DEFAULT 'void'"]]);
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS tweets_bot_idx ON tweets(bot, status, mode, scheduled_at)").run();
  schemaReady = true;
}

async function addColumns(env, table, columns) {
  const have = new Set(((await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results || []).map(c => c.name));
  for (const [name, type] of columns) {
    if (!have.has(name)) await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run();
  }
}

async function getConfig(env, bot) {
  const defaults = BOTS[bot].defaults;
  const row = await env.DB.prepare("SELECT value FROM tw_config WHERE key=?").bind(configKey(bot)).first();
  let stored = {};
  try { stored = row ? JSON.parse(row.value) : {}; } catch {}
  const cfg = { ...defaults, ...stored, bot };
  cfg.topicPlan = Object.fromEntries(Object.keys(BOTS[bot].topics).map(k => [k, Number(stored.topicPlan?.[k] ?? defaults.topicPlan[k]) || 0]));
  cfg.maxPerDay = planTotal(bot, cfg.topicPlan); // el máximo diario es la suma del plan
  return cfg;
}

async function saveConfig(env, bot, patch) {
  const { bot: _ignored, ...next } = { ...(await getConfig(env, bot)), ...patch };
  await env.DB.prepare(
    "INSERT INTO tw_config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(configKey(bot), JSON.stringify(next)).run();
  return { ...next, bot };
}

function validateConfig(bot, body) {
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
  if (bot === "stayliquid") {
    num("minTradePct", 0, 10000);
    num("minTradeSol", 0, 1000);
  }

  for (const key of ["windowStart", "windowEnd", "linkEvery"]) {
    if (out[key] !== undefined) out[key] = Math.round(out[key]);
  }

  if (body.language !== undefined) out.language = body.language === "es" ? "es" : "en";

  if (body.topicPlan !== undefined) {
    const plan = {};
    for (const key of Object.keys(BOTS[bot].topics)) {
      const n = Math.round(Number(body.topicPlan?.[key]) || 0);
      if (n < 0 || n > 50) throw new UserError("Cada tema debe tener entre 0 y 50 tweets.");
      plan[key] = n;
    }
    const total = planTotal(bot, plan);
    if (total < 1 || total > 100) throw new UserError("El plan del día debe sumar entre 1 y 100 tweets.");
    out.topicPlan = plan;
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

async function insertTweet(env, bot, { text, mode, articleUrl, articleTitle, articleSummary = null, topic, linkUrl = null }) {
  const topics = BOTS[bot].topics;
  const safeTopic = topics[topic] ? topic : (topics.other ? "other" : Object.keys(topics)[0]);
  const result = await env.DB.prepare(`
    INSERT INTO tweets(bot, text, mode, status, has_link, article_url, article_title, article_summary, topic, link_url, created_at)
    VALUES(?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
  `).bind(bot, text, mode, hasLink(text) ? 1 : 0, articleUrl, articleTitle, articleSummary, safeTopic, linkUrl, new Date().toISOString()).run();
  return result.meta.last_row_id;
}

async function log(env, bot, level, message) {
  await env.DB.prepare("INSERT INTO tw_log(bot, level, message, created_at) VALUES(?, ?, ?, ?)")
    .bind(bot, level, String(message).slice(0, 2000), new Date().toISOString()).run();
  await env.DB.prepare("DELETE FROM tw_log WHERE id <= (SELECT MAX(id) - 1000 FROM tw_log)").run();
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

// X convierte en enlace cualquier dominio aunque no lleve https:// (pump.fun, x.com...), y eso lo cobra como enlace.
const BARE_DOMAIN = /(^|[^\w@/.-])((?:[a-z0-9-]+\.)+(?:com|net|org|io|fun|tech|xyz|app|ai|co|dev|gg|so|me|finance|money|exchange|trade|news|info|tv|ly|to|sh|us|uk|es|cc|pro|bot|lol|meme|sol|wtf))(?![\w-])/gi;

function hasLink(text) {
  const withoutUrls = String(text).replace(/https?:\/\/\S+/gi, " ");
  return /https?:\/\/\S+/i.test(text) || new RegExp(BARE_DOMAIN.source, "i").test(withoutUrls);
}

// Quita los dominios sueltos que escribe la IA (pump.fun → Pump fun) para que X no los convierta en enlace.
// Los enlaces completos (https://...) que pone el bot a propósito se respetan.
function stripBareDomains(text) {
  return String(text).split(/(https?:\/\/\S+)/i).map((part, i) => i % 2 ? part : part.replace(BARE_DOMAIN, (_, pre, domain) => {
    if (/^pump\.fun$/i.test(domain)) return `${pre}Pump fun`;
    if (/^stayliquid\./i.test(domain)) return `${pre}StayLiquid`;
    const name = domain.split(".")[0];
    return pre + name.charAt(0).toUpperCase() + name.slice(1);
  })).join("");
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
