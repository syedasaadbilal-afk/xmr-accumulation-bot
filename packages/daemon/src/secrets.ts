import fs from "node:fs";
import path from "node:path";

export interface BitfinexSecrets {
  apiKey: string;
  apiSecret: string;
}

/** Credentials live in a 0600 file next to the DB inside the mounted data volume, never in the image. */
function secretsPath(dbPath: string): string {
  return path.join(path.dirname(dbPath), "bfx-secrets.json");
}

export function readSecrets(dbPath: string): BitfinexSecrets {
  try {
    const file = secretsPath(dbPath);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BitfinexSecrets>;
      if (parsed.apiKey && parsed.apiSecret) return { apiKey: parsed.apiKey, apiSecret: parsed.apiSecret };
    }
  } catch {
    // treated as not configured
  }
  return { apiKey: process.env.BFX_API_KEY ?? "", apiSecret: process.env.BFX_API_SECRET ?? "" };
}

export function writeSecrets(dbPath: string, secrets: BitfinexSecrets): void {
  const file = secretsPath(dbPath);
  fs.writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function hasSecrets(dbPath: string): boolean {
  const s = readSecrets(dbPath);
  return s.apiKey.length > 0 && s.apiSecret.length > 0;
}
