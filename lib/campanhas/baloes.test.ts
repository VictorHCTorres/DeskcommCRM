/**
 * O laço dos balões (`enviarEmBaloes`): a ordem, a parada na falha e a pergunta `continuar` (cartão I, 11/11/2026).
 *
 * O índice do desfecho decide o 429 da rodada: só no 1º balão o destinatário volta à fila, porque depois dele a
 * pessoa já recebeu o começo. Por isso o índice tem de ser o do ÚLTIMO balão que saiu (ou falhou), nunca o seguinte.
 */
import { describe, expect, it } from "vitest";

import { enviarEmBaloes } from "./baloes";

function laco(desfechos: Array<{ status: string }>, continuar?: (i: number) => Promise<boolean>) {
  const passos: string[] = [];
  const executar = enviarEmBaloes(["A", "B", "C"], {
    enviar: async (corpo, i) => {
      passos.push(`enviar:${corpo}`);
      return { ...desfechos[i]!, i };
    },
    registrar: async (i) => void passos.push(`registrar:${i}`),
    esperar: async () => void passos.push("esperar"),
    ...(continuar
      ? {
          continuar: async (i: number) => {
            passos.push(`continuar:${i}`);
            return continuar(i);
          },
        }
      : {}),
  });
  return { passos, executar };
}

const SAIU = { status: "queued" };
const FALHOU = { status: "failed" };

describe("enviarEmBaloes", () => {
  it("todos saem, em ordem, com a pausa entre eles; o desfecho é o do último", async () => {
    const { passos, executar } = laco([SAIU, SAIU, SAIU]);
    const r = await executar;
    expect(passos).toEqual([
      "enviar:A",
      "registrar:0",
      "esperar",
      "enviar:B",
      "registrar:1",
      "esperar",
      "enviar:C",
      "registrar:2",
    ]);
    expect(r.indiceDoDesfecho).toBe(2);
    expect(r.primeira).toMatchObject({ i: 0 });
    expect(r.desfecho).toMatchObject({ i: 2 });
  });

  it("⭐ o 2º falha: para ali, e o índice do desfecho é 1 (o começo já saiu)", async () => {
    const { passos, executar } = laco([SAIU, FALHOU, SAIU]);
    const r = await executar;
    expect(passos).not.toContain("enviar:C");
    expect(r.indiceDoDesfecho).toBe(1);
    expect(r.desfecho).toMatchObject({ status: "failed", i: 1 });
  });

  it("⭐ `continuar` é perguntado DEPOIS da pausa, e `false` para: o desfecho é o do último que saiu", async () => {
    const { passos, executar } = laco([SAIU, SAIU, SAIU], async () => false);
    const r = await executar;
    expect(passos).toEqual(["enviar:A", "registrar:0", "esperar", "continuar:1"]);
    expect(r.indiceDoDesfecho).toBe(0);
    expect(r.desfecho).toMatchObject({ i: 0 });
  });

  it("controle: `continuar` verdadeiro não muda nada; o 1º balão nunca pergunta", async () => {
    const { passos, executar } = laco([SAIU, SAIU, SAIU], async () => true);
    const r = await executar;
    expect(passos.filter((p) => p.startsWith("continuar"))).toEqual(["continuar:1", "continuar:2"]);
    expect(r.indiceDoDesfecho).toBe(2);
  });
});

/**
 * F4i do cxj (11/11/2026): na prospecção, todo balão passa pela conferência final dentro do handler. O veto num
 * balão SEGUINTE chega como `null` do `enviar` (o começo já saiu e não volta; o resto não vai), e o balão que o canal
 * segurou (`parar`) para os seguintes: se o canal voltasse na pausa, o próximo sairia sem o anterior.
 */
describe("enviarEmBaloes × o balão vetado e o balão retido (F4i)", () => {
  function comNulo(nuloEm: number) {
    const passos: string[] = [];
    const executar = enviarEmBaloes(["A", "B", "C"], {
      enviar: async (corpo, i) => {
        passos.push(`enviar:${corpo}`);
        return i === nuloEm ? null : { status: "sent", i };
      },
      registrar: async (i) => void passos.push(`registrar:${i}`),
      esperar: async () => void passos.push("esperar"),
    });
    return { passos, executar };
  }

  it("⭐ o 2º balão vetado (`null`): para ali, sem registrar o vetado, e o desfecho é o do 1º", async () => {
    const { passos, executar } = comNulo(1);
    const r = await executar;
    expect(passos).toEqual(["enviar:A", "registrar:0", "esperar", "enviar:B"]);
    expect(r.indiceDoDesfecho).toBe(0);
    expect(r.desfecho).toMatchObject({ i: 0 });
    expect(r.primeira).toMatchObject({ i: 0 });
  });

  it("⭐ o 1º balão não pode voltar `null`: sem desfecho não há o que gravar, e o laço recusa", async () => {
    const { passos, executar } = comNulo(0);
    await expect(executar).rejects.toThrow(/1º balão/);
    expect(passos).toEqual(["enviar:A"]);
  });

  it("⭐ `parar` verdadeiro depois do 1º: o 2º não sai, nem há pausa, e o desfecho é o retido", async () => {
    const passos: string[] = [];
    const r = await enviarEmBaloes(["A", "B"], {
      enviar: async (corpo, i) => (passos.push(`enviar:${corpo}`), { status: "queued", i }),
      esperar: async () => void passos.push("esperar"),
      parar: (d) => d.status === "queued",
    });
    expect(passos).toEqual(["enviar:A"]);
    expect(r.indiceDoDesfecho).toBe(0);
    expect(r.desfecho).toMatchObject({ status: "queued", i: 0 });
  });

  it("controle: `parar` falso não muda nada", async () => {
    const passos: string[] = [];
    const r = await enviarEmBaloes(["A", "B"], {
      enviar: async (corpo, i) => (passos.push(`enviar:${corpo}`), { status: "sent", i }),
      esperar: async () => void passos.push("esperar"),
      parar: () => false,
    });
    expect(passos).toEqual(["enviar:A", "esperar", "enviar:B"]);
    expect(r.indiceDoDesfecho).toBe(1);
  });
});
