import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import { parseConfig, type BotConfig } from "./config.js";
import { hasSecrets, writeSecrets } from "./secrets.js";
import type { XmrService } from "./service.js";

export interface CreateServerOptions {
  service: XmrService;
  port: number;
  /** Built dashboard assets; skipped if missing (API still works). */
  staticDir?: string;
  /** SQLite path - the credentials file is stored next to it. */
  dbPath: string;
}

export async function createServer(opts: CreateServerOptions) {
  const { service } = opts;
  const fastify = Fastify({ logger: false });

  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    await fastify.register(fastifyStatic, { root: opts.staticDir });
    fastify.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api/")) {
        reply.code(404).send({ error: "not found" });
        return;
      }
      reply.sendFile("index.html");
    });
  } else {
    console.warn(`[xmr] dashboard static dir not found (${opts.staticDir ?? "unset"}) - serving API only`);
  }

  fastify.get("/api/status", async () => service.status());

  fastify.get("/api/secrets", async () => ({ configured: hasSecrets(opts.dbPath) }));

  fastify.put("/api/secrets", async (req, reply) => {
    const body = req.body as { apiKey?: string; apiSecret?: string } | undefined;
    const apiKey = body?.apiKey?.trim();
    const apiSecret = body?.apiSecret?.trim();
    if (!apiKey || !apiSecret) {
      reply.code(400);
      return { error: "apiKey and apiSecret are both required" };
    }
    writeSecrets(opts.dbPath, { apiKey, apiSecret });
    // A new key means the wallet baseline may belong to a different account.
    const st = service.store.getState();
    service.store.setState({ ...st, snapshot: null, strandedUst: 0, heldBackXmr: 0 });
    console.log("[xmr] Bitfinex API credentials updated via dashboard.");
    return { configured: true };
  });

  fastify.put("/api/config", async (req, reply) => {
    const parsed = parseConfig(req.body);
    if ("error" in parsed) {
      reply.code(400);
      return { error: parsed.error };
    }
    const before = service.store.getConfig();
    service.store.setConfig(parsed.config);
    const c = parsed.config;
    service.store.addEvent(
      "config",
      `Config saved: enabled=${c.enabled}, mode=${c.mode}, chunk $${c.chunkUsd}, reserves ${c.reservesEnabled && c.btcReserve > 0 ? `${c.btcReserve} BTC / ${c.xautReserve} XAUT` : "off"}, strategy cap ${c.strategyCap.enabled ? `${c.strategyCap.maxDistPct}%` : "off"}, new-money cap ${c.newMoneyCap.enabled ? `${c.newMoneyCap.maxDistPct}% (lump >= ${c.newMoneyCap.minLumpPct}%)` : "off"}, position cap ${c.positionCapXmr > 0 ? `${c.positionCapXmr} XMR` : "off"}`
    );
    if (before.mode !== c.mode) console.log(`[xmr] mode changed ${before.mode} -> ${c.mode}`);
    return { ok: true };
  });

  // Run-mode switch for the Status tab: PAUSED = disabled, DRY_RUN / LIVE = enabled in that mode.
  fastify.put("/api/mode", async (req, reply) => {
    const m = (req.body as { mode?: string } | undefined)?.mode;
    if (m !== "DRY_RUN" && m !== "LIVE" && m !== "PAUSED") {
      reply.code(400);
      return { error: "mode must be DRY_RUN, LIVE or PAUSED" };
    }
    const c = service.store.getConfig();
    const next: BotConfig = m === "PAUSED" ? { ...c, enabled: false } : { ...c, enabled: true, mode: m };
    service.store.setConfig(next);
    service.store.addEvent("config", `Run mode set to ${m}`);
    console.log(`[xmr] run mode -> ${m}`);
    return { ok: true };
  });

  fastify.post("/api/run-now", async () => {
    service.tick().catch((err) => console.error("[xmr] manual tick failed:", err));
    return { started: true };
  });

  // Record a transfer the bot missed (for example one made while a rotation was running), so the since-start percentage stays right.
  fastify.post("/api/transfer", async (req, reply) => {
    const b = req.body as { asset?: string; amount?: number; ts?: number } | undefined;
    const asset = b?.asset;
    const amount = b?.amount;
    const ts = b?.ts ?? Date.now();
    if ((asset !== "XMR" && asset !== "BTC") || typeof amount !== "number" || !Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1_000_000) {
      reply.code(400);
      return { error: "asset must be XMR or BTC and amount a non-zero number (negative = withdrawal)" };
    }
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts < Date.now() - 800 * 86_400_000 || ts > Date.now() + 3_600_000) {
      reply.code(400);
      return { error: "the time is out of range" };
    }
    const price = service.store.snapshots(5).at(-1)?.price;
    if (asset === "BTC" && !(price && price > 0)) {
      reply.code(400);
      return { error: "no price recorded yet to value a BTC transfer" };
    }
    const valueXmr = asset === "BTC" ? amount / (price as number) : amount;
    const what = amount < 0 ? "manual entry: withdrawal" : "manual entry: deposit";
    service.store.addDeposit({ ts, asset, amount, valueXmr, dist: null, action: what });
    service.store.addEvent("deposit", `Manual transfer recorded: ${amount > 0 ? "+" : ""}${amount} ${asset}`);
    return { ok: true };
  });

  // Start measuring the since-start percentage from now (for example after a transfer the bot did not see).
  fastify.post("/api/reset-performance", async () => {
    const st = service.store.getState();
    service.store.setState({ ...st, perfSince: Date.now() });
    service.store.addEvent("info", "Performance measure reset: the since-start percentage now counts from this moment");
    return { ok: true };
  });

  fastify.post("/api/clear-held-back", async () => {
    const st = service.store.getState();
    service.store.setState({ ...st, heldBackXmr: 0 });
    service.store.addEvent("info", "Held-back XMR released manually");
    return { ok: true };
  });

  await fastify.listen({ port: opts.port, host: "0.0.0.0" });
  console.log(`[xmr] dashboard/API listening on :${opts.port}`);
  return fastify;
}
