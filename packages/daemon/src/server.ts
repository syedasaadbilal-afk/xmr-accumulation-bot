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
      `Config saved: enabled=${c.enabled}, mode=${c.mode}, chunk $${c.chunkUsd}, USDT reserve ${c.usdtReserve > 0 ? `$${c.usdtReserve}` : "off"}, strategy cap ${c.strategyCap.enabled ? `${c.strategyCap.maxDistPct}%` : "off"}, new-money cap ${c.newMoneyCap.enabled ? `${c.newMoneyCap.maxDistPct}% (lump >= ${c.newMoneyCap.minLumpPct}%)` : "off"}, position cap ${c.positionCapXmr > 0 ? `${c.positionCapXmr} XMR` : "off"}`
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
