/**
 * O envio rápido: a rodada manda em rajada, com o espaçamento e o prazo dela,
 * e para no primeiro desfecho que valeria para os envios seguintes.
 *
 * Relógio de mentira: `esperar` avança o tempo em vez de dormir, e cada envio
 * "leva" 300 ms. Assim o teste mede o ritmo de verdade sem levar 38 segundos.
 */
import { describe, expect, it } from "vitest";

import { RajadaInterrompida, desfechoParaARajada, rodarEmRajada, type DesfechoDeUm } from "./rajada";

const CONFIG = { concorrencia: 4, intervaloEntreIniciosMs: 167, tamanhoDoLote: 24, prazoMs: 38_000 };

function cenario(opts: {
  pendentes: number;
  desfecho?: (id: number) => DesfechoDeUm;
  emAndamentoAte?: number;
  duracaoDoEnvioMs?: number;
}) {
  let relogio = 0;
  const fila = Array.from({ length: opts.pendentes }, (_, i) => i);
  const enviados: number[] = [];
  const inicios: number[] = [];
  let perguntasDeAndamento = 0;
  let concluiu = 0;
  return {
    enviados,
    inicios,
    get concluiu() {
      return concluiu;
    },
    dep: {
      buscarLote: async (n: number) => fila.splice(0, n),
      enviarUm: async (id: number) => {
        inicios.push(relogio);
        relogio += opts.duracaoDoEnvioMs ?? 300;
        enviados.push(id);
        return opts.desfecho?.(id) ?? { enviadas: 1, pulados: 0, concluidas: 0, detalhe: "enviado:sent:principal" };
      },
      aindaEmAndamento: async () => ++perguntasDeAndamento <= (opts.emAndamentoAte ?? Infinity),
      concluirSeAcabou: async () => {
        concluiu++;
        return { enviadas: 0, pulados: 0, concluidas: 1, detalhe: "concluida" };
      },
      agora: () => relogio,
      esperar: async (ms: number) => {
        relogio += ms;
      },
    },
  };
}

describe("rodarEmRajada", () => {
  it("manda a lista inteira numa rodada quando cabe no prazo, e conclui", async () => {
    const c = cenario({ pendentes: 60 });
    const r = await rodarEmRajada(c.dep, CONFIG);
    expect(r.enviadas).toBe(60);
    expect(r.concluidas).toBe(1);
    expect(c.concluiu).toBe(1);
    expect(new Set(c.enviados).size).toBe(60); // ninguém duas vezes
  });

  it("nunca começa mais de 6 envios por segundo", async () => {
    const c = cenario({ pendentes: 100, duracaoDoEnvioMs: 0 });
    await rodarEmRajada(c.dep, CONFIG);
    for (let i = 1; i < c.inicios.length; i++) {
      expect(c.inicios[i]! - c.inicios[i - 1]!).toBeGreaterThanOrEqual(167);
    }
  });

  it("para de começar envios no prazo — o resto sai na rodada seguinte", async () => {
    // Envio instantâneo: o relógio de mentira soma as durações em série e não
    // mediria a concorrência — aqui quem manda é o espaçamento.
    const c = cenario({ pendentes: 1000, duracaoDoEnvioMs: 0 });
    const r = await rodarEmRajada(c.dep, CONFIG);
    // 38 s a 6 por segundo: 228 inícios, nunca a lista inteira.
    expect(r.enviadas).toBeGreaterThanOrEqual(220);
    expect(r.enviadas).toBeLessThanOrEqual(228);
    expect(c.concluiu).toBe(0);
    expect(r.detalhe).toMatch(/:prazo$/);
  });

  it("a campanha pausou por falha da plataforma: nenhum envio novo depois", async () => {
    const c = cenario({
      pendentes: 50,
      desfecho: (id) =>
        id === 5
          ? { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "pausada:132015" }
          : { enviadas: 1, pulados: 0, concluidas: 0, detalhe: "enviado:sent:principal" },
    });
    const r = await rodarEmRajada(c.dep, CONFIG);
    // Os que já estavam em voo terminam (até 3 além do 5); nenhum começa depois.
    expect(c.enviados.length).toBeLessThanOrEqual(9);
    expect(r.detalhe).toMatch(/pausada:132015$/);
  });

  it("o provedor pediu para desacelerar: a rajada para e o resto espera a próxima rodada", async () => {
    const c = cenario({
      pendentes: 50,
      desfecho: (id) =>
        id === 10
          ? { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "limite:429" }
          : { enviadas: 1, pulados: 0, concluidas: 0, detalhe: "enviado:sent:principal" },
    });
    const r = await rodarEmRajada(c.dep, CONFIG);
    expect(c.enviados.length).toBeLessThan(15);
    expect(r.detalhe).toMatch(/limite:429$/);
  });

  it("pausar pela tela entre um lote e outro para a rajada", async () => {
    const c = cenario({ pendentes: 100, emAndamentoAte: 1 });
    const r = await rodarEmRajada(c.dep, CONFIG);
    expect(r.enviadas).toBe(24); // só o primeiro lote
    expect(r.detalhe).toMatch(/fora_de_andamento$/);
  });

  it("devolve todos os números por onde falou, cada um uma vez (#3112)", async () => {
    const c = cenario({
      pendentes: 9,
      desfecho: (id) => ({
        enviadas: 1,
        pulados: 0,
        concluidas: 0,
        detalhe: "enviado:sent:rodizio",
        numero: id % 3 === 0 ? "vinculado" : "principal",
      }),
    });
    const r = await rodarEmRajada(c.dep, CONFIG);
    expect(r.enviadas).toBe(9);
    expect([...r.numeros].sort()).toEqual(["principal", "vinculado"]);
  });

  it("pulados (bloqueado, exclusão) não param a rajada", async () => {
    const c = cenario({
      pendentes: 30,
      desfecho: (id) =>
        id % 3 === 0
          ? { enviadas: 0, pulados: 1, concluidas: 0, detalhe: "pulado:opt_out" }
          : { enviadas: 1, pulados: 0, concluidas: 0, detalhe: "enviado:sent:principal" },
    });
    const r = await rodarEmRajada(c.dep, CONFIG);
    expect(r.enviadas + r.pulados).toBe(30);
    expect(r.pulados).toBe(10);
  });
});

describe("a rajada que para por erro leva o que já fez (F4k, K08 do cxj)", () => {
  const pelo = (numero: string) => (): DesfechoDeUm => ({
    enviadas: 1,
    pulados: 0,
    concluidas: 0,
    detalhe: "enviado:sent:rodizio",
    numero,
  });

  it("a leitura do lote seguinte falha: o erro sobe com os envios e os números do lote que já saiu", async () => {
    const c = cenario({ pendentes: 30, desfecho: pelo("vinculado") });
    let leituras = 0;
    const erro = await rodarEmRajada(
      {
        ...c.dep,
        buscarLote: async (n: number) => {
          if (++leituras === 2) throw new Error("a fila da campanha não foi lida: banco fora");
          return c.dep.buscarLote(n);
        },
      },
      CONFIG,
    ).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(RajadaInterrompida);
    expect((erro as RajadaInterrompida).message).toBe("a fila da campanha não foi lida: banco fora");
    expect((erro as RajadaInterrompida).parcial).toEqual({
      enviadas: 24,
      pulados: 0,
      concluidas: 0,
      detalhe: "rajada:24(enviado×24):erro",
      numeros: ["vinculado"],
    });
  });

  it("a conclusão no fim da fila falha (a contagem não veio): o erro sobe com o que saiu", async () => {
    const c = cenario({ pendentes: 5, desfecho: pelo("vinculado") });
    const erro = await rodarEmRajada(
      {
        ...c.dep,
        concluirSeAcabou: async () => {
          throw new Error("a contagem da fila da campanha não foi lida: sem contagem");
        },
      },
      CONFIG,
    ).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(RajadaInterrompida);
    expect((erro as RajadaInterrompida).parcial).toMatchObject({ enviadas: 5, numeros: ["vinculado"] });
  });

  /** O envio do 4 demora (uma volta do relógio de verdade): ainda está em voo quando o 5 quebra. */
  const comO4EmVoo = (c: ReturnType<typeof cenario>, depoisDoVoo?: () => never) => async (id: number) => {
    const r = await c.dep.enviarUm(id);
    if (id === 4) {
      await new Promise((ok) => setTimeout(ok, 0));
      depoisDoVoo?.();
    }
    return r;
  };

  it("um envio lança: nenhum envio novo começa, e o que estava em voo termina e entra no parcial", async () => {
    const c = cenario({
      pendentes: 24,
      desfecho: (id) => {
        if (id === 5) throw new Error("o envio quebrou");
        return pelo(id === 4 ? "terceiro" : "principal")();
      },
    });
    const erro = await rodarEmRajada({ ...c.dep, enviarUm: comO4EmVoo(c) }, CONFIG).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(RajadaInterrompida);
    expect((erro as RajadaInterrompida).message).toBe("o envio quebrou");
    // Os que já estavam em voo terminam (até 3 além do 5); nenhum começa depois.
    expect(c.enviados.length).toBeLessThanOrEqual(9);
    // Todo envio que começou, menos o que quebrou, terminou e entrou na conta, inclusive o 4.
    expect((erro as RajadaInterrompida).parcial.enviadas).toBe(c.enviados.length - 1);
    expect([...(erro as RajadaInterrompida).parcial.numeros].sort()).toEqual(["principal", "terceiro"]);
  });

  it("dois envios lançam: o erro sobe com o primeiro, leva os dois, e a mensagem diz os dois", async () => {
    const c = cenario({
      pendentes: 24,
      desfecho: (id) => {
        if (id === 5) throw new Error("o envio quebrou");
        return pelo("principal")();
      },
    });
    const emVoo = comO4EmVoo(c, () => {
      throw new Error("o envio em voo também quebrou");
    });
    const erro = await rodarEmRajada({ ...c.dep, enviarUm: emVoo }, CONFIG).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(RajadaInterrompida);
    expect((erro as RajadaInterrompida).message).toBe(
      "o envio quebrou (e mais 1 na mesma rajada: o envio em voo também quebrou)",
    );
    expect((erro as RajadaInterrompida).causas.map((e) => (e as Error).message)).toEqual([
      "o envio quebrou",
      "o envio em voo também quebrou",
    ]);
  });
});

describe("desfechoParaARajada", () => {
  it("só o que valeria para os envios seguintes para a rajada", () => {
    for (const d of ["pausada:131048", "ritmo:fora_da_janela", "canal:sem_numero_livre", "limite:130429", "erro_na_reserva:x", "org_nao_operante"]) {
      expect(desfechoParaARajada(d)).toBe(true);
    }
    for (const d of ["enviado:sent:principal", "pulado:opt_out", "pulado:suprimido", "falhou", "ja_reservado", "falha:modelo_sem_valores"]) {
      expect(desfechoParaARajada(d)).toBe(false);
    }
  });
});
