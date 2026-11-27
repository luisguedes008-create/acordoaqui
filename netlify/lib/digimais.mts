// Utilitários do portal Digimais (digimais.acordoaqui.com.br).
// Reaproveita comum.mts (Supabase, Turnstile, origem, IP). O token de sessão é próprio
// (formato diferente do JWT da FLEX, então um não serve no lugar do outro).
// Variáveis: usa SESSION_SECRET, SUPABASE_*, TURNSTILE_* da FLEX.
// Opcionais: DG_CHAVE_VALIDACAO ('nascimento' padrão | 'email'), DG_PRAZO_MAX_DIAS (padrão 10).
import { env, sb } from "./comum.mts";

const enc = new TextEncoder();

export const CHAVE = (env("DG_CHAVE_VALIDACAO") ?? "nascimento").toLowerCase();
export const PRAZO_MAX = parseInt(env("DG_PRAZO_MAX_DIAS") ?? "10", 10);
export const MAX_FALHAS_HORA = 5;

export const soDigitos = (s: unknown) => String(s ?? "").replace(/\D/g, "");

export function cpfValido(cpf: string) {
  cpf = soDigitos(cpf);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const n of [9, 10]) {
    let s = 0;
    for (let i = 0; i < n; i++) s += +cpf[i] * (n + 1 - i);
    if (((s * 10) % 11) % 10 !== +cpf[n]) return false;
  }
  return true;
}

// Supabase: lança erro se a resposta não for OK e devolve o JSON
export async function sbJson(path: string, init: RequestInit = {}) {
  const r = await sb(path, init);
  if (!r.ok) throw new Error(`Supabase ${init.method ?? "GET"} ${path.split("?")[0]}: ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// ---------- token de sessão: dg.<payload>.<hmac> (30 min) ----------
const b64u = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const deB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function chave(usos: KeyUsage[]) {
  const segredo = env("SESSION_SECRET");
  if (!segredo || segredo.length < 32) throw new Error("SESSION_SECRET ausente ou curto");
  return crypto.subtle.importKey("raw", enc.encode("digimais:" + segredo), { name: "HMAC", hash: "SHA-256" }, false, usos);
}

export async function assinar(cpf: string) {
  const p = b64u(enc.encode(JSON.stringify({ cpf, exp: Date.now() + 30 * 60 * 1000 })));
  const s = new Uint8Array(await crypto.subtle.sign("HMAC", await chave(["sign"]), enc.encode(p)));
  return `dg.${p}.${b64u(s)}`;
}

export async function verificar(token: unknown): Promise<{ cpf: string } | null> {
  try {
    const [pre, p, s] = String(token ?? "").split(".");
    if (pre !== "dg" || !p || !s) return null;
    if (!(await crypto.subtle.verify("HMAC", await chave(["verify"]), deB64u(s), enc.encode(p)))) return null;
    const d = JSON.parse(new TextDecoder().decode(deB64u(p)));
    return d.exp > Date.now() && cpfValido(d.cpf) ? { cpf: d.cpf } : null;
  } catch {
    return null;
  }
}

export function somarDias(iso: string, n: number) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const fimDeSemana = (iso: string) => [0, 6].includes(new Date(iso + "T12:00:00Z").getUTCDay());
