// POST /api/dg/solicitar  { token, parcelas:[{contrato,parcela}], dataPagamento, canal, destino }
// Portal Digimais: registra o pedido de boleto. A operação emite no Digi+ e envia pelo canal escolhido.
import type { Config, Context } from "@netlify/functions";
import { json, ipDe, origemPermitida, hojeBrasilia } from "../lib/comum.mts";
import { PRAZO_MAX, soDigitos, sbJson, verificar, somarDias, fimDeSemana } from "../lib/digimais.mts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default async (req: Request, ctx: Context) => {
  if (req.method !== "POST") return json({ erro: "Método não permitido" }, 405);
  if (!origemPermitida(req)) return json({ erro: "origem" }, 403);

  let e: any;
  try { e = await req.json(); } catch { return json({ erro: "Requisição inválida" }, 400); }

  const sessao = await verificar(e.token);
  if (!sessao) return json({ erro: "Sua sessão expirou. Faça a consulta novamente.", expirou: true }, 401);
  const cpf = sessao.cpf;

  // Data: de hoje até hoje + prazo, só segunda a sexta
  const hoje = hojeBrasilia();
  const data = String(e.dataPagamento ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || data < hoje || data > somarDias(hoje, PRAZO_MAX))
    return json({ erro: `Escolha uma data entre hoje e os próximos ${PRAZO_MAX} dias.` }, 400);
  if (fimDeSemana(data)) return json({ erro: "Escolha um dia útil (segunda a sexta)." }, 400);

  // Canal e destino
  const canal = e.canal === "email" ? "email" : e.canal === "whatsapp" ? "whatsapp" : null;
  if (!canal) return json({ erro: "Escolha WhatsApp ou e-mail." }, 400);
  let destino = String(e.destino ?? "").trim();
  if (canal === "whatsapp") {
    destino = soDigitos(destino);
    if (destino.startsWith("55") && destino.length >= 12) destino = destino.slice(2);
    if (!/^\d{2}9\d{8}$/.test(destino)) return json({ erro: "Informe um celular com DDD (ex.: 51 99999-9999)." }, 400);
  } else if (!EMAIL_RE.test(destino) || destino.length > 120) {
    return json({ erro: "Informe um e-mail válido." }, 400);
  }

  const pedidas = Array.isArray(e.parcelas) ? e.parcelas.slice(0, 200) : [];
  if (!pedidas.length) return json({ erro: "Selecione ao menos uma parcela." }, 400);

  try {
    // Só parcelas do próprio CPF, em aberto e vencidas
    const abertas = await sbJson(
      `dg_parcelas?select=contrato,produto,parcela,vencimento,valor&cpf=eq.${cpf}&situacao=eq.aberta&vencimento=lt.${hoje}`,
    );
    const k = (p: any) => `${p.contrato}#${p.parcela}`;
    const mapa = new Map(abertas.map((p: any) => [k(p), p]));
    const escolhidas = pedidas.map((p: any) => mapa.get(k(p))).filter(Boolean) as any[];
    if (escolhidas.length !== pedidas.length)
      return json({ erro: "Algumas parcelas mudaram. Faça a consulta novamente." }, 409);

    const [cliente] = await sbJson(`dg_clientes?select=nome&cpf=eq.${cpf}`);
    const total = escolhidas.reduce((s, p) => s + Number(p.valor), 0);
    const aleatorio = crypto.getRandomValues(new Uint16Array(1))[0] % 9000 + 1000;
    const protocolo = `DG${hoje.slice(2).replace(/-/g, "")}${aleatorio}`;

    await sbJson("dg_solicitacoes", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({
        protocolo, cpf, nome: cliente?.nome ?? "",
        parcelas: escolhidas,
        valor_total: Math.round(total * 100) / 100,
        data_pagamento: data, canal, destino,
        ip: ipDe(req, ctx), user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300),
      }),
    });

    return json({ protocolo, dataPagamento: data, canal, destino });
  } catch (err) {
    console.error("dg-solicitar", err);
    return json({ erro: "Não foi possível registrar agora. Tente novamente em instantes." }, 500);
  }
};

export const config: Config = { path: "/api/dg/solicitar" };
