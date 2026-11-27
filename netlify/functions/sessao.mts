import type { Context, Config } from "@netlify/functions";
import {
  json, sleep, hashDado, ipDe, origemPermitida, slugDaCarteira, verificarTurnstile, sb,
  assinarToken, cpfValido, emailValido, diasDeAtraso, mascararNome, mascararContrato, env, carregarRegras } from "../lib/comum.mts";
import { calcAcordo, totalComTaxa, maxParcelasCartao } from "../lib/calculo.mts";

// POST /api/sessao
// Body: { cpf, email, telefone, autoriza, turnstile, xq_ref }  (xq_ref = campo-isca invisível; website = nome antigo)
// Valida o cliente (CPF + e-mail do cadastro) e devolve um token curto + os dados mínimos do acordo.

const LIMITE_IP = 10;          // tentativas erradas por IP em 10 min
const LIMITE_CPF = 5;          // tentativas erradas por CPF em 30 min
const TEMPO_MIN_MS = 700;      // tempo mínimo de resposta (acerto e erro demoram parecido)

// Mesma resposta para "CPF inexistente" e "e-mail diferente": quem tenta não descobre qual dado errou.
const FALHA = { erro: "nao_encontrado", mensagem: "Os dados informados não conferem com o cadastro. Confira o CPF e o e-mail ou fale com a nossa equipe no WhatsApp." };
const BLOQUEIO = { erro: "muitas_tentativas", mensagem: "Muitas tentativas. Aguarde alguns minutos ou fale com a gente pelo WhatsApp ou telefone." };

async function falhasRecentes(coluna: "ip" | "cpf_hash", valor: string, minutos: number): Promise<number> {
  const desde = new Date(Date.now() - minutos * 60000).toISOString();
  const r = await sb(`tentativas_consulta?${coluna}=eq.${encodeURIComponent(valor)}&ok=eq.false&criado_em=gte.${encodeURIComponent(desde)}&select=id&limit=50`);
  if (!r.ok) throw new Error("falha ao ler tentativas");
  return (await r.json()).length;
}

async function registrar(ip: string, cpfHash: string | null, ok: boolean) {
  await sb("tentativas_consulta", { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify({ ip, cpf_hash: cpfHash, ok }) });
}

export default async (req: Request, ctx: Context) => {
  const inicio = Date.now();
  const resp = async (body: unknown, status: number) => {
    const resta = TEMPO_MIN_MS - (Date.now() - inicio);
    if (resta > 0) await sleep(resta);
    return json(body, status);
  };

  if (req.method !== "POST") return json({ erro: "metodo" }, 405);
  if (!origemPermitida(req)) return json({ erro: "origem" }, 403);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return resp(FALHA, 400); }

  // Isca para robôs: campo invisível que pessoas não preenchem.
  if ((typeof b.xq_ref === "string" && b.xq_ref.trim() !== "") || (typeof b.website === "string" && b.website.trim() !== "")) { console.error("sessao: isca preenchida"); return resp(FALHA, 401); }

  const cpf = String(b.cpf ?? "").replace(/\D/g, "");
  const tel = String(b.telefone ?? "").replace(/\D/g, "");
  const email = String(b.email ?? "").trim().toLowerCase();
  if (!cpfValido(cpf) || !(tel.length === 10 || tel.length === 11) || !emailValido(email)) {
    return resp({ erro: "dados_invalidos", mensagem: "Confira o CPF, o e-mail e o telefone." }, 400);
  }

  const ip = await hashDado(ipDe(req, ctx));
  const cpfHash = await hashDado(cpf);

  try {
    // 1) limites de tentativas (antes de gastar a validação do Turnstile e a consulta)
    if ((await falhasRecentes("ip", ip, 10)) >= LIMITE_IP || (await falhasRecentes("cpf_hash", cpfHash, 30)) >= LIMITE_CPF) {
      return resp(BLOQUEIO, 429);
    }

    // 2) anti-robô
    if (!(await verificarTurnstile(String(b.turnstile ?? ""), ipDe(req, ctx)))) {
      return resp({ erro: "verificacao", mensagem: "Não foi possível confirmar que você é uma pessoa. Atualize a página e tente de novo." }, 400);
    }

    // 3) carteira (credor) pelo subdomínio
    const slugCart = encodeURIComponent(slugDaCarteira(req));
    let cr = await sb(`carteiras?slug=eq.${slugCart}&ativo=eq.true&select=id,credor_nome,produto,whatsapp,telefone,soma_comissao&limit=1`);
    // coluna soma_comissao ainda não criada (migration v9): lê sem ela, a carteira não soma comissão
    if (!cr.ok) cr = await sb(`carteiras?slug=eq.${slugCart}&ativo=eq.true&select=id,credor_nome,produto,whatsapp,telefone&limit=1`);
    const carteira = (await cr.json())?.[0];
    if (!carteira) return resp(FALHA, 404);

    // 4) contrato: CPF + e-mail do cadastro + carteira, ainda pendente (e-mail guardado em minúsculas)
    const kr = await sb(
      `contratos?cpf=eq.${cpf}&email=eq.${encodeURIComponent(email)}&carteira_id=eq.${carteira.id}&status=eq.pendente&select=id,cliente_nome,contrato_numero,data_vencimento,valor_principal,juros,multa&order=data_vencimento.asc&limit=10`,
    );
    const todos: any[] = (await kr.json()) ?? [];
    if (todos.length === 0) {
      await registrar(ip, cpfHash, false);
      return resp(FALHA, 401);
    }
    // contrato sem data de vencimento não dá para calcular: fica de fora (e se não sobrar nenhum, vai para a equipe)
    const contratos = todos.filter((c) => !!c.data_vencimento);
    if (contratos.length === 0) {
      return resp({ erro: "indisponivel", mensagem: "Seu acordo precisa ser conferido por um consultor. Fale com a gente." }, 422);
    }

    await registrar(ip, cpfHash, true);

    // 5) contato com autorização LGPD (opcional, desmarcada por padrão)
    const autoriza = b.autoriza === true;
    await sb("contatos", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({
        carteira_id: carteira.id, cpf, telefone: tel, email,
        autoriza_contato: autoriza, autorizacao_em: autoriza ? new Date().toISOString() : null,
      }),
    });

    // 6) cálculo no servidor, um por contrato, com as regras DESTA carteira
    let regras;
    try { regras = await carregarRegras(carteira.id); }
    catch (e) {   // carteira sem regras cadastradas: não calcula; leva o cliente à equipe
      console.error("sessao: regras", e instanceof Error ? e.message : e);
      return resp({ erro: "indisponivel", mensagem: "Seu acordo precisa ser conferido por um consultor. Fale com a gente." }, 422);
    }
    const lista = contratos.map((c) => {
      const dias = diasDeAtraso(c.data_vencimento);
      const a = calcAcordo({ principal: Number(c.valor_principal), juros: Number(c.juros), multa: Number(c.multa), diasAtraso: dias }, regras, carteira.soma_comissao === true);
      return {
        id: c.id, numero: mascararContrato(c.contrato_numero), diasAtraso: dias,
        principal: Number(c.valor_principal), juros: Number(c.juros), multa: Number(c.multa),
        acordo: { valorAtualizado: a.valorAtualizado, desconto: a.desconto, honorarios: a.honorarios, economia: Math.max(0, +(a.valorAtualizado - a.valorAcordo).toFixed(2)), valorAcordo: a.valorAcordo },
        opcoes: {
          pix: totalComTaxa(a.valorAcordo, "pix").total,
          boleto: totalComTaxa(a.valorAcordo, "boleto").total,
          cartao: Array.from({ length: 12 }, (_, k) => totalComTaxa(a.valorAcordo, "cartao", k + 1).total),
          cartaoMax: maxParcelasCartao(a.valorAcordo),
        },
      };
    });

    // 7) token curto (não leva CPF): só autoriza pagar os contratos listados acima
    const { token, exp } = await assinarToken({ ctr: lista.map((c) => c.id), cid: carteira.id, cpfh: cpfHash });

    // O percentual da faixa não é enviado ao navegador; só o valor dos honorários (quando a carteira soma a comissão).
    return resp({
      token, expiraEm: exp,
      carteira: { credor: carteira.credor_nome, produto: carteira.produto, whatsapp: carteira.whatsapp, telefone: carteira.telefone },
      cliente: { nome: mascararNome(contratos[0].cliente_nome) },
      contratos: lista,
    }, 200);
  } catch (e) {
    console.error("sessao: erro interno", e instanceof Error ? e.message : e); // sem dados pessoais no log
    return resp({ erro: "interno", mensagem: "Não foi possível consultar agora. Tente novamente ou fale com a gente." }, 500);
  }
};

export const config: Config = { path: "/api/sessao" };
