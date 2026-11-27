import { regrasDeLinhas } from "./calculo.mts";
// Utilitários compartilhados pelas funções (fora de netlify/functions, para não virar endpoint).

const enc = new TextEncoder();
export const env = (k: string) => Netlify.env.get(k);

export function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- hash e base64url ----------
export async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const hashDado = (valor: string) => sha256Hex(`${env("HASH_PEPPER") ?? env("SESSION_SECRET") ?? ""}:${valor}`);

const b64u = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uJson = (o: unknown) => b64u(enc.encode(JSON.stringify(o)));
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// ---------- token de sessão (JWT HS256) ----------
async function chaveHmac(usos: KeyUsage[]) {
  const segredo = env("SESSION_SECRET");
  if (!segredo || segredo.length < 32) throw new Error("SESSION_SECRET ausente ou curto (mín. 32 caracteres)");
  return crypto.subtle.importKey("raw", enc.encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, usos);
}

// ctr = ids dos contratos que ESTA sessão pode pagar (todos do mesmo CPF e e-mail confirmados)
export type Claims = { ctr: string[]; cid: string; cpfh: string; iat: number; exp: number };

export async function assinarToken(dados: Omit<Claims, "iat" | "exp">, ttlSeg = 25 * 60): Promise<{ token: string; exp: number }> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSeg;
  const corpo = `${b64uJson({ alg: "HS256", typ: "JWT" })}.${b64uJson({ ...dados, iat, exp })}`;
  const sig = await crypto.subtle.sign("HMAC", await chaveHmac(["sign"]), enc.encode(corpo));
  return { token: `${corpo}.${b64u(sig)}`, exp };
}

export async function verificarToken(token: string): Promise<Claims | null> {
  try {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return null;
    const ok = await crypto.subtle.verify("HMAC", await chaveHmac(["verify"]), fromB64u(s), enc.encode(`${h}.${p}`));
    if (!ok) return null;
    const head = JSON.parse(new TextDecoder().decode(fromB64u(h)));
    if (head.alg !== "HS256") return null;
    const c = JSON.parse(new TextDecoder().decode(fromB64u(p))) as Claims;
    if (!c.exp || c.exp < Math.floor(Date.now() / 1000)) return null;
    return c;
  } catch {
    return null;
  }
}

// ---------- origem, host e IP ----------
export function origemPermitida(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false; // chamadas do navegador sempre enviam Origin em POST
  const extras = (env("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (extras.includes(origin)) return true;
  return /^https:\/\/([a-z0-9-]+\.)?acordoaqui\.com\.br$/.test(origin) || origin === "https://negocieaqui.netlify.app";
}

export function slugDaCarteira(req: Request): string {
  const origin = req.headers.get("origin") ?? "";
  const m = origin.match(/^https:\/\/([a-z0-9-]+)\.acordoaqui\.com\.br$/);
  if (m && m[1] !== "www") return m[1];
  return env("DEFAULT_CARTEIRA_SLUG") ?? "flex";
}

export const ipDe = (req: Request, ctx?: { ip?: string }) =>
  ctx?.ip ?? req.headers.get("x-nf-client-connection-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "0.0.0.0";

// ---------- Cloudflare Turnstile ----------
export async function verificarTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  if (env("TURNSTILE_DISABLED") === "true") return true; // somente para testes locais
  const segredo = env("TURNSTILE_SECRET_KEY");
  if (!segredo) { console.error("turnstile: TURNSTILE_SECRET_KEY não configurada"); return false; } // falha fechada
  if (!token) { console.error("turnstile: navegador não enviou o token (widget não carregou?)"); return false; }
  const form = new URLSearchParams({ secret: segredo, response: token, remoteip: ip });
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const j = await r.json();
    if (j?.success !== true) console.error("turnstile: recusado", JSON.stringify({ codigos: j?.["error-codes"], host: j?.hostname })); // sem dados pessoais
    return j?.success === true;
  } catch (e) {
    console.error("turnstile: falha ao consultar o Cloudflare", e instanceof Error ? e.message : e);
    return false;
  }
}

// ---------- Supabase (REST) com a chave de serviço ----------
export async function sb(path: string, init: RequestInit = {}) {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase não configurado");
  const headers: Record<string, string> = { apikey: key, "content-type": "application/json", ...(init.headers as Record<string, string>) };
  if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`; // chave legada (JWT); as novas sb_secret_ não usam Bearer
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers });
}

// Regras de desconto/TAC da carteira (por faixa de dias de atraso). Sem regras = erro (não calcula nada "no escuro").
export async function carregarRegras(carteiraId: string) {
  const r = await sb(`regras_faixa?carteira_id=eq.${encodeURIComponent(carteiraId)}&select=dias_de,dias_ate,desc_principal,desc_juros,desc_multa,tac_pct&order=dias_de.asc`);
  if (!r.ok) throw new Error("falha ao ler regras");
  const linhas = await r.json();
  if (!Array.isArray(linhas) || linhas.length === 0) throw new Error("carteira sem regras de faixa");
  return regrasDeLinhas(linhas);
}

// ---------- Asaas ----------
export async function asaas(path: string, init: RequestInit = {}) {
  const key = env("ASAAS_API_KEY");
  if (!key) throw new Error("ASAAS_API_KEY ausente");
  const base = env("ASAAS_API_URL") ?? "https://api-sandbox.asaas.com/v3";
  return fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", access_token: key, "User-Agent": "acordoaqui/1.0", ...(init.headers as Record<string, string>) },
  });
}

// ---------- validações ----------
export function cpfValido(c: string): boolean {
  const s = c.replace(/\D/g, "");
  if (s.length !== 11 || /^(\d)\1{10}$/.test(s)) return false;
  for (const t of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(s[i]) * (t + 1 - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== Number(s[t])) return false;
  }
  return true;
}

// "DD/MM/AAAA" -> "AAAA-MM-DD" ou null
export function dataParaIso(d: string): string | null {
  const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, aaaa] = m;
  const dt = new Date(Date.UTC(+aaaa, +mm - 1, +dd));
  if (dt.getUTCFullYear() !== +aaaa || dt.getUTCMonth() !== +mm - 1 || dt.getUTCDate() !== +dd) return null;
  if (+aaaa < 1900 || dt.getTime() > Date.now()) return null;
  return `${aaaa}-${mm}-${dd}`;
}

export const emailValido = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 160;

// data de hoje no fuso de Brasília, como "AAAA-MM-DD"
export function hojeBrasilia(offsetDias = 0): string {
  const d = new Date(Date.now() + offsetDias * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
}

export function diasDeAtraso(vencimentoIso: string): number {
  const a = Date.parse(hojeBrasilia() + "T00:00:00Z");
  const b = Date.parse(vencimentoIso + "T00:00:00Z");
  return Math.max(0, Math.floor((a - b) / 86400000));
}

export function mascararNome(nome: string): string {
  const p = nome.trim().split(/\s+/);
  const ini = (s: string) => s[0].toUpperCase() + "***";
  return p.length === 1 ? ini(p[0]) : `${ini(p[0])} ${ini(p[p.length - 1])}`;
}
export const mascararContrato = (n?: string | null) => (n ? `•••• ${String(n).slice(-4)}` : "••••");
