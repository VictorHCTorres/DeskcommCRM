/**
 * O RELÓGIO DA SAÍDA EM TODO CHAMADOR DA CADEIA (versão 16, F4u do cxj, U02).
 *
 * A cadeia grava o registro da saída na hora do relógio que recebe, lido depois da espera do intervalo
 * (`RunBeforeSendArgs.relogio`). Sem ele, o registro cai em `now` mais a espera, e `now` é lido pelo chamador antes da
 * pausa humana e da classificação: a linha fica segundos antes da saída de verdade, e o próximo envio do número mede o
 * intervalo a partir dela. O comportamento da cadeia com e sem o relógio está provado no Postgres
 * (`tests/invariants/hora-da-vaga-no-envio.test.ts`); aqui, a fiação: cada chamador de produção passa o relógio, como
 * o teste da afirmação clínica confere a dele (`gate-afirmacao-clinica.test.ts`), pelo texto do arquivo.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const fonte = (arquivo: string) => readFileSync(join(process.cwd(), "lib/agent-engine/agent", arquivo), "utf8");
const conta = (texto: string, padrao: RegExp) => [...texto.matchAll(padrao)].length;

describe("o relógio da saída chega à cadeia por todo chamador de produção", () => {
  it("o turno da IA: as três chamadas diretas e os três avisos com o `clock` do turno, e os dois da escolta", () => {
    const turno = fonte("inbound-turn.ts");
    // As chamadas diretas da cadeia (o modelo aprovado, a resposta e a pergunta repetida) e os avisos de base.
    expect(conta(turno, /now: clock\(\),\n\s*relogio: clock,\n/g)).toBe(5);
    // Os avisos da escolta do orçamento e do fechamento, que leem o relógio das dependências.
    expect(conta(turno, /now: deps\.clock\?\.\(\) \?\? new Date\(\),\n\s*relogio: deps\.clock \?\? \(\(\): Date => new Date\(\)\),\n/g)).toBe(2);
    // As reexecuções da cadeia herdam o relógio do objeto da primeira.
    expect(conta(turno, /runBeforeSend\(\{\n\s*\.\.\.beforeSendArgs,/g)).toBe(2);
    // Uma chamada nova da cadeia tem de entrar nesta conta.
    expect(conta(turno, /runBeforeSend\(/g)).toBe(5);
  });

  it("o follow-up passa o `clock` dele", () => {
    const followup = fonte("followup-turn.ts");
    expect(conta(followup, /now: clock\(\),\n\s*relogio: clock,\n/g)).toBe(1);
    expect(conta(followup, /runBeforeSend\(/g)).toBe(1);
  });

  it("a entrega do Meet e a resposta aprovada passam o relógio do processo", () => {
    for (const arquivo of ["meet-delivery.ts", "approved-reply.ts"]) {
      const texto = fonte(arquivo);
      expect(conta(texto, /now: new Date\(\),\n\s*relogio: \(\) => new Date\(\),\n/g), arquivo).toBe(1);
      expect(conta(texto, /runBeforeSend\(/g), arquivo).toBe(1);
    }
  });

  it("o aviso de escalação repassa o relógio que recebe", () => {
    const aviso = fonte("aviso-de-escalacao.ts");
    expect(aviso).toMatch(/now: opts\.now,\n\s*\.\.\.\(opts\.relogio !== undefined \? \{ relogio: opts\.relogio \} : \{\}\),\n/);
    expect(conta(aviso, /runBeforeSend\(/g)).toBe(1);
  });
});
