// POST /api/dg/consultar  { cpf, chave, turnstile }
// Portal Digimais: valida CPF + data de nascimento (ou e-mail) e devolve as parcelas vencidas em aberto.
import type { Config, Context } from "@netlify/functions";
import { json, ipDe, origemPermitida, verificarTurnstile, hojeBrasilia } from "../lib/comum.mts";
import { CHAVE, PRAZO_MAX, MAX_FALHAS_HORA, soDigitos, cpfValido, sbJson, assinar } from "../lib/digimais.mts";

export default async (req: Request, ctx: Context) => {
  if (req.method !== "POST") return json({ erro: "Método não permitido" }, 405);
  if (!origemPermitida(req)) return json({ erro: "origem" }, 403);

  let e: any;
  try { e = await req.json(); } catch { return json({ erro: "Requisição inválida" }, 400); }

  const ip = ipDe(req, ctx);
  const cpf = soDigitos(e.cpf);
  if (!cpfValido(cpf)) return json({ erro: "CPF inválido." }, 400);
  if (!(await verificarTurnstile(e.turnstile, ip)))
    return json({ erro: "Verificação de segurança falhou. Recarregue a página e tente de novo." }, 400);

  try {
    const desde = new Date(Date.now() - 3600_000).toISOString();
    const falhas = await sbJson(`dg_tentativas?select=id&cpf=eq.${cpf}&ok=eq.false&criado_em=gte.${desde}`);
    if (falhas.length >= MAX_FALHAS_HORA)
      return json({ erro: "Muitas tentativas. Tente novamente em 1 hora ou fale com nossa equipe.", bloqueado: true }, 429);

    const [cliente] = await sbJson(`dg_clientes?select=cpf,nome,email,telefone,nascimento&cpf=eq.${cpf}`);
    const informado = String(e.chave ?? "").trim();
    let confere = false;
    if (cliente) {
      confere = CHAVE === "email"
        ? !!cliente.email && cliente.email.trim().toLowerCase() === informado.toLowerCase()
        : !!cliente.nascimento && cliente.nascimento === informado;
    }
    await sbJson("dg_tentativas", { method: "POST", body: JSON.stringify({ cpf, ok: confere, ip }) });

    if (!cliente) return json({ erro: "Não encontramos parcelas em aberto para este CPF.", naoEncontrado: true }, 404);
    if (!confere) return json({ erro: "Os dados não conferem com o cadastro." }, 401);

    const hoje = hojeBrasilia();
    const parcelas = await sbJson(
      `dg_parcelas?select=contrato,produto,parcela,vencimento,valor&cpf=eq.${cpf}&situacao=eq.aberta&vencimento=lt.${hoje}&order=contrato,parcela`,
    );
    const [pendente] = await sbJson(
      `dg_solicitacoes?select=protocolo,data_pagamento,canal,criado_em&cpf=eq.${cpf}&status=eq.pendente&order=criado_em.desc&limit=1`,
    );

    return json({
      token: await assinar(cpf),
      nome: cliente.nome,
      email: cliente.email ?? "",
      telefone: cliente.telefone ?? "",
      hoje,
      prazoMaxDias: PRAZO_MAX,
      parcelas,
      pendente: pendente ?? null,
    });
  } catch (err) {
    console.error("dg-consultar", err);
    return json({ erro: "Não foi possível consultar agora. Tente novamente em instantes." }, 500);
  }
};

export const config: Config = { path: "/api/dg/consultar" };
