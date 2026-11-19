// Regra de cálculo do acordo — fonte da verdade no SERVIDOR.
// O navegador só exibe; o valor cobrado no Asaas é sempre recalculado aqui.
//
// As regras são POR CREDOR (tabela regras_faixa, ligada à carteira), por faixa de dias de atraso:
//   desconto sobre o principal (e, se o credor tiver, sobre juros e multa) + TAC/comissão.
// A TAC/comissão NÃO é somada ao cliente: serve só para relatório (é retida do que o credor recebe).
// Taxas do Asaas: SEMPRE repassadas ao cliente (o credor recebe o valor do acordo cheio).

export type Regra = { de: number; ate: number; descPrincipal: number; descJuros: number; descMulta: number; tacPct: number };

// Converte as linhas da tabela regras_faixa (dias_ate nulo = sem limite).
export function regrasDeLinhas(linhas: any[]): Regra[] {
  return (linhas ?? [])
    .map((l) => ({
      de: Number(l.dias_de),
      ate: l.dias_ate === null || l.dias_ate === undefined ? Infinity : Number(l.dias_ate),
      descPrincipal: Number(l.desc_principal ?? 0),
      descJuros: Number(l.desc_juros ?? 0),
      descMulta: Number(l.desc_multa ?? 0),
      tacPct: Number(l.tac_pct ?? 0),
    }))
    .sort((a, b) => a.de - b.de);
}

// Tabela padrão Asaas (conferida em 22/10/2026). Confirmar a taxa real da conta.
export type Forma = "pix" | "boleto" | "cartao";
export function taxaAsaas(forma: Forma, parcelas = 1) {
  if (forma === "cartao") {
    return { fixo: 0.49, pct: parcelas === 1 ? 0.0299 : parcelas <= 6 ? 0.0349 : 0.0399 };
  }
  return { fixo: 1.99, pct: 0 };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

// Faixa do contrato; sem regra para esses dias = null (quem chama deve parar e mandar para a equipe).
export function faixaDe(regras: Regra[], dias: number): Regra | null {
  return regras.find((f) => dias >= f.de && dias <= f.ate) ?? null;
}

export function calcAcordo(c: { principal: number; juros: number; multa: number; diasAtraso: number }, regras: Regra[]) {
  const f = faixaDe(regras, c.diasAtraso);
  if (!f) throw new Error("sem regra de faixa para " + c.diasAtraso + " dias");
  const desconto = r2(c.principal * f.descPrincipal + c.juros * f.descJuros + c.multa * f.descMulta);
  const valorAtualizado = r2(c.principal + c.juros + c.multa);
  const valorAcordo = r2(valorAtualizado - desconto);
  return {
    faixa: f,
    desconto,
    honorarios: 0,                         // nada é somado ao cliente
    comissao: r2(valorAcordo * f.tacPct),  // só para relatório interno
    valorAtualizado,
    valorAcordo,
  };
}

// Antecipação do cartão: o Asaas paga o cartão em 32 dias (parcela a parcela). Para receber
// em até 2 dias úteis, antecipa-se cobrando juros simples ao mês sobre cada parcela.
// O cliente paga o suficiente para o credor receber o valorAcordo LÍQUIDO, já antecipado.
// Calibrado no simulador do Asaas (R$ 400 em 12x -> R$ 352,74 antecipado). Revisar se mudar a taxa da conta.
export const ANTECIPACAO = { avistaMes: 0.0125, parceladoMes: 0.017, diasParaReceber: 32.1 };

// Fração do valor líquido que sobra depois de antecipar todas as parcelas (parcela i vence em 32*i dias).
export function fatorAntecipacao(parcelas: number) {
  const taxa = parcelas === 1 ? ANTECIPACAO.avistaMes : ANTECIPACAO.parceladoMes;
  const mesesMedios = (ANTECIPACAO.diasParaReceber / 30) * (parcelas + 1) / 2;
  return 1 - taxa * mesesMedios;
}

// Total que o cliente paga para o credor receber exatamente valorAcordo.
// Pix/boleto: só a taxa fixa. Cartão: taxa do cartão (% + fixo) e custo de antecipação.
export function totalComTaxa(valorAcordo: number, forma: Forma, parcelas = 1) {
  const t = taxaAsaas(forma, parcelas);
  const liquido = forma === "cartao" ? valorAcordo / fatorAntecipacao(parcelas) : valorAcordo;
  const total = Math.ceil(((liquido + t.fixo) / (1 - t.pct)) * 100 - 1e-9) / 100;
  return { total, taxa: r2(total - valorAcordo) };
}

// O Asaas recusa cartão com parcela abaixo de R$ 5,00 ("valor mínimo para cobranças via Cartão de Crédito é R$ 5,00").
export const PARCELA_MINIMA = 5;
// Maior número de parcelas (até 12) em que cada parcela ainda fica >= R$ 5,00. 0 = cartão indisponível.
export function maxParcelasCartao(valorAcordo: number) {
  let max = 0;
  for (let n = 1; n <= 12; n++) {
    if (totalComTaxa(valorAcordo, "cartao", n).total / n >= PARCELA_MINIMA) max = n; else break;
  }
  return max;
}
