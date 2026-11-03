import { instanteDe, partesNoFuso } from "@/lib/agenda/fuso";
import { fusoValido } from "@/lib/tempo/fusos";
import type { FrequenciaDaRecorrencia } from "@/lib/tarefas/tipos";

export interface RegraDeRecorrencia {
  frequency: FrequenciaDaRecorrencia;
  interval: number;
  timezone: string;
}

function ultimoDiaDoMes(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

/**
 * Calcula uma ocorrência sempre a partir da âncora original. Assim uma série
 * mensal iniciada no dia 31 gera 28/29 em fevereiro e volta ao dia 31 em março.
 * A hora é hora de parede no fuso congelado da série; `instanteDe` trata DST.
 */
export function instanteDaGeracao(ancora: Date, geracao: number, regra: RegraDeRecorrencia): Date {
  if (!Number.isInteger(geracao) || geracao < 0) throw new Error("geracao_invalida");
  if (!Number.isInteger(regra.interval) || regra.interval < 1)
    throw new Error("intervalo_invalido");
  if (!fusoValido(regra.timezone)) throw new Error("fuso_invalido");

  const base = partesNoFuso(ancora, regra.timezone);
  if (geracao === 0) return instanteDe(base, regra.timezone);

  if (regra.frequency === "monthly") {
    const indice = base.ano * 12 + (base.mes - 1) + geracao * regra.interval;
    const ano = Math.floor(indice / 12);
    const mes = (indice % 12) + 1;
    return instanteDe(
      { ...base, ano, mes, dia: Math.min(base.dia, ultimoDiaDoMes(ano, mes)) },
      regra.timezone,
    );
  }

  const dias = geracao * regra.interval * (regra.frequency === "weekly" ? 7 : 1);
  const calendario = new Date(Date.UTC(base.ano, base.mes - 1, base.dia + dias));
  return instanteDe(
    {
      ...base,
      ano: calendario.getUTCFullYear(),
      mes: calendario.getUTCMonth() + 1,
      dia: calendario.getUTCDate(),
    },
    regra.timezone,
  );
}

/** Próximo prazo contado da conclusão, usado pelo modo after_completion. */
export function instanteAposConclusao(conclusao: Date, regra: RegraDeRecorrencia): Date {
  return instanteDaGeracao(conclusao, 1, regra);
}
