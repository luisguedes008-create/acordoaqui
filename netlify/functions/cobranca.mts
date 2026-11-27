import type { Context, Config } from "@netlify/functions";
import { json, origemPermitida, verificarToken, sb, asaas, hojeBrasilia, diasDeAtraso, env, carregarRegras } from "../lib/comum.mts";
import { calcAcordo, totalComTaxa, maxParcelasCartao, type Forma } from "../lib/calculo.mts";

// POST /api/cobranca   (Authorization: Bearer <token da /api/sessao>)
// Body: { contrato: "<id de um contrato da sessão>", forma: "pix" | "boleto" | "cartao", parcelas?: 1..12 }
// O valor NUNCA vem do navegador: é recalculado aqui a partir do contrato.
// Dados de cartão NUNCA passam por aqui: o cartão é pago na página segura do Asaas (invoiceUrl).

const BILLING = { pix: "PIX", boleto: "BOLETO", cartao: "CREDIT_CARD" } as const;

export default async (req: Request, _ctx: Context) => {
  if (req.method !== "POST") return json({ erro: "metodo" }, 405);
  if (!origemPermitida(req)) return json({ erro: "origem" }, 403);

  const auth = req.headers.get("authorization") ?? "";
  const claims = auth.startsWith("Bearer ") ? await verificarToken(auth.slice(7)) : null;
  if (!claims) return json({ erro: "sessao_expirada", mensagem: "Sua sessão expirou. Consulte o acordo novamente." }, 401);

  let b: { contrato?: string; forma?: string; parcelas?: number };
  try { b = await req.json(); } catch { return json({ erro: "dados_invalidos" }, 400); }
  // só paga contrato que a sessão confirmou (CPF + e-mail); qualquer outro id é recusado
  const contratoId = String(b.contrato ?? "");
  if (!contratoId || !Array.isArray(claims.ctr) || !claims.ctr.includes(contratoId)) return json({ erro: "dados_invalidos" }, 400);
  const forma = b.forma as Forma;
  if (!["pix", "boleto", "cartao"].includes(forma)) return json({ erro: "dados_invalidos" }, 400);
  const parcelas = forma === "cartao" ? Math.floor(Number(b.parcelas ?? 1)) : 1;
  if (!(parcelas >= 1 && parcelas <= 12)) return json({ erro: "dados_invalidos" }, 400);

  try {
    // contrato e carteira vêm do banco, pelo que está assinado no token
    const kr = await sb(`contratos?id=eq.${encodeURIComponent(contratoId)}&carteira_id=eq.${claims.cid}&status=eq.pendente&select=id,carteira_id,cliente_nome,cpf,contrato_numero,data_vencimento,valor_principal,juros,multa&limit=1`);
    const contrato = (await kr.json())?.[0];
    if (!contrato) return json({ erro: "indisponivel", mensagem: "Este acordo não está mais disponível. Fale com a gente." }, 409);

    const regras = await carregarRegras(claims.cid);
    const cart = (await (await sb(`carteiras?id=eq.${encodeURIComponent(claims.cid)}&select=soma_comissao&limit=1`)).json())?.[0];
    const a = calcAcordo({
      principal: Number(contrato.valor_principal), juros: Number(contrato.juros), multa: Number(contrato.multa),
      diasAtraso: diasDeAtraso(contrato.data_vencimento),
    }, regras, cart?.soma_comissao === true);
    if (forma === "cartao") {
      const max = maxParcelasCartao(a.valorAcordo);
      if (max === 0) return json({ erro: "cartao_indisponivel", mensagem: "Este valor não pode ser pago no cartão. Escolha Pix ou boleto." }, 400);
      if (parcelas > max) return json({ erro: "parcelas_invalidas", mensagem: "Para este valor o cartão parcela em até " + max + "x (parcela mínima de R$ 5,00)." }, 400);
    }
    const t = totalComTaxa(a.valorAcordo, forma, parcelas);

    // contato mais recente (e-mail e telefone) para o cadastro no Asaas
    const cor = await sb(`contatos?cpf=eq.${contrato.cpf}&select=email,telefone&order=criado_em.desc&limit=1`);
    const contato = (await cor.json())?.[0] ?? {};

    // cliente no Asaas (reaproveita pelo CPF). Notificações do Asaas desligadas: quem fala com o cliente somos nós.
    const buscar = await (await asaas(`/customers?cpfCnpj=${contrato.cpf}`)).json();
    let customerId: string | undefined = buscar?.data?.[0]?.id;
    if (!customerId) {
      const cr = await asaas("/customers", {
        method: "POST",
        body: JSON.stringify({ name: contrato.cliente_nome, cpfCnpj: contrato.cpf, email: contato.email, mobilePhone: contato.telefone, notificationDisabled: true }),
      });
      const c = await cr.json();
      if (!cr.ok) { console.error("asaas cliente", cr.status, JSON.stringify((c?.errors ?? []).map((e: any) => ({ c: e.code, d: e.description })))); return json({ erro: "gateway" }, 502); }
      customerId = c.id;
    }

    // reaproveita cobrança igual criada há menos de 2h (evita duplicar ao clicar duas vezes)
    const desde = new Date(Date.now() - 2 * 3600000).toISOString();
    const ex = await (await sb(
      `cobrancas_asaas?negociacao_id=eq.${contrato.id}&billing_type=eq.${BILLING[forma]}&numero_parcelas=eq.${parcelas}&valor_total=eq.${t.total}&status=eq.PENDING&criado_em=gte.${encodeURIComponent(desde)}&select=asaas_payment_id&limit=1`,
    )).json();

    let pagamento: Record<string, any>;
    if (ex?.[0]?.asaas_payment_id) {
      pagamento = await (await asaas(`/payments/${ex[0].asaas_payment_id}`)).json();
    } else {
      const payload: Record<string, unknown> = {
        customer: customerId,
        billingType: BILLING[forma],
        dueDate: hojeBrasilia(3),
        externalReference: contrato.id,
        description: `Acordo - contrato ${String(contrato.contrato_numero ?? "").slice(-4)}`,
      };
      if (parcelas > 1) { payload.installmentCount = parcelas; payload.totalValue = t.total; } else { payload.value = t.total; }

      const pr = await asaas("/payments", { method: "POST", body: JSON.stringify(payload) });
      pagamento = await pr.json();
      if (!pr.ok) { console.error("asaas cobranca", pr.status, JSON.stringify((pagamento?.errors ?? []).map((e: any) => ({ c: e.code, d: e.description })))); return json({ erro: "gateway", mensagem: "Não foi possível gerar a cobrança agora. Tente novamente ou fale com a gente." }, 502); }

      await sb("cobrancas_asaas", {
        method: "POST", headers: { prefer: "return=minimal" },
        body: JSON.stringify({
          carteira_id: contrato.carteira_id, contrato_id: contrato.id, forma_parcelamento: forma === "cartao" ? "cartao" : "avista",
          billing_type: BILLING[forma], negociacao_id: contrato.id, asaas_customer_id: customerId, asaas_payment_id: pagamento.id,
          asaas_installment_id: pagamento.installment ?? null, valor_total: t.total, valor_acordo: a.valorAcordo, taxa_asaas: t.taxa,
          honorarios: a.honorarios, comissao: a.comissao, faixa_dias_de: a.faixa.de, numero_parcelas: parcelas,
          status: pagamento.status ?? "PENDING", invoice_url: pagamento.invoiceUrl ?? null,
        }),
      });
    }

    // dados para o cliente pagar
    const saida: Record<string, unknown> = { forma, parcelas, total: t.total, taxa: t.taxa, vencimento: pagamento.dueDate };
    if (forma === "pix") {
      const q = await (await asaas(`/payments/${pagamento.id}/pixQrCode`)).json();
      saida.pix = { copiaECola: q.payload, qrCodeBase64: q.encodedImage, expira: q.expirationDate };
    } else if (forma === "boleto") {
      const l = await (await asaas(`/payments/${pagamento.id}/identificationField`)).json();
      saida.boleto = { linhaDigitavel: l.identificationField, url: pagamento.bankSlipUrl };
    } else {
      saida.cartao = { url: pagamento.invoiceUrl };
    }
    return json(saida, 201);
  } catch (e) {
    console.error("cobranca: erro interno", e instanceof Error ? e.message : e);
    return json({ erro: "interno", mensagem: "Não foi possível gerar a cobrança agora. Tente novamente ou fale com a gente." }, 500);
  }
};

export const config: Config = { path: "/api/cobranca" };
