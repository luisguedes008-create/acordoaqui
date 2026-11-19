import type { Context, Config } from "@netlify/functions";
import { json, env, sb } from "../lib/comum.mts";

// POST /api/asaas/webhook  — eventos de cobrança do Asaas.
// Configure em Asaas > Integrações > Webhooks, com o MESMO token de ASAAS_WEBHOOK_TOKEN.
// Regras: token obrigatório (sem token configurado, recusa tudo), eventos repetidos são ignorados,
// e só damos baixa em cobranças que nós mesmos criamos.

const PAGOS = new Set(["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"]);

function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export default async (req: Request, _ctx: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // trim nos dois lados: espaço ou quebra de linha colados junto com o token não podem derrubar o webhook
  const esperado = (env("ASAAS_WEBHOOK_TOKEN") ?? "").trim();
  const recebido = (req.headers.get("asaas-access-token") ?? "").trim();
  if (!esperado || !iguais(recebido, esperado)) {
    // só os tamanhos (nunca os valores): ajuda a achar token vazio, cortado ou com caractere a mais
    console.error("webhook 401: tamanho recebido", recebido.length, "esperado", esperado.length);
    return new Response("Unauthorized", { status: 401 });
  }

  let evento: any;
  try { evento = await req.json(); } catch { return new Response("Bad request", { status: 400 }); }
  const pay = evento?.payment;
  if (!evento?.id || !evento?.event || !pay?.id) return new Response("Bad request", { status: 400 });

  try {
    // idempotência: se o id do evento já foi registrado, não processa de novo
    const reg = await sb("webhook_eventos", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ evento_id: evento.id, tipo: evento.event, payment_id: pay.id }),
    });
    if (reg.status === 409) return new Response("OK", { status: 200 });
    if (!reg.ok) throw new Error("falha ao registrar evento");

    // só cobranças criadas por nós
    const cr = await sb(`cobrancas_asaas?asaas_payment_id=eq.${encodeURIComponent(pay.id)}&select=id,negociacao_id&limit=1`);
    const cobranca = (await cr.json())?.[0];
    if (!cobranca) return new Response("OK", { status: 200 });

    const up = await sb(`cobrancas_asaas?id=eq.${cobranca.id}`, {
      method: "PATCH", headers: { prefer: "return=minimal" },
      body: JSON.stringify({ status: pay.status, evento_tipo: evento.event, atualizado_em: new Date().toISOString(), data_pagamento: pay.paymentDate ?? null }),
    });
    if (!up.ok) throw new Error("falha ao atualizar cobrança");

    if (PAGOS.has(evento.event)) {
      const ct = await sb(`contratos?id=eq.${cobranca.negociacao_id}`, {
        method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ status: "pago" }),
      });
      if (!ct.ok) throw new Error("falha ao dar baixa no contrato");
    }
    return new Response("OK", { status: 200 });
  } catch (e) {
    console.error("webhook: erro", e instanceof Error ? e.message : e);
    // libera o id do evento para o Asaas poder reenviar
    try { await sb(`webhook_eventos?evento_id=eq.${encodeURIComponent(evento.id)}`, { method: "DELETE" }); } catch { /* ignora */ }
    return new Response("Erro", { status: 500 });
  }
};

export const config: Config = { path: "/api/asaas/webhook" };
