import { describe, expect, it } from "vitest";

import { bancoFalso } from "@/tests/helpers/banco-falso-da-cobranca";

import { conferirVinculosDaTarefa } from "./vinculos";

describe("vínculos tenant-safe da tarefa", () => {
  it("aceita lead e contato encontrados na organização e usa a tabela contacts", async () => {
    const banco = bancoFalso((cadeia) => ({ data: { id: `${cadeia.tabela}-1` } }));
    await expect(
      conferirVinculosDaTarefa(banco.cliente as never, "org-1", {
        lead_id: "lead-1",
        contact_id: "contact-1",
      }),
    ).resolves.toBe("ok");
    expect(banco.cadeias.map((cadeia) => cadeia.tabela)).toEqual(["crm_leads", "contacts"]);
    expect(
      banco.cadeias.every((cadeia) =>
        cadeia.passos.some(
          (passo) => passo.metodo === "eq" && passo.args.join(":") === "organization_id:org-1",
        ),
      ),
    ).toBe(true);
  });

  it("recusa lead ou contato que não aparece na mesma organização", async () => {
    const banco = bancoFalso((cadeia) => ({
      data: cadeia.tabela === "crm_leads" ? { id: "lead-1" } : null,
    }));
    const veredito = await conferirVinculosDaTarefa(banco.cliente as never, "org-1", {
      lead_id: "lead-1",
      contact_id: "contact-de-outra-org",
    });
    expect(veredito).toBe("fora_da_organizacao");
    for (const cadeia of banco.cadeias) {
      expect(cadeia.passos).toContainEqual({ metodo: "eq", args: ["organization_id", "org-1"] });
    }
    expect(banco.cadeias.map((cadeia) => cadeia.tabela)).toEqual(["crm_leads", "contacts"]);
  });

  it("não consulta vínculo nulo e distingue falha de banco", async () => {
    const banco = bancoFalso(() => ({ data: null, error: { message: "indisponível" } }));
    expect(
      await conferirVinculosDaTarefa(banco.cliente as never, "org-1", {
        lead_id: "lead-1",
        contact_id: null,
      }),
    ).toBe("falha_na_consulta");
    expect(banco.cadeias.map((cadeia) => cadeia.tabela)).toEqual(["crm_leads"]);
  });
});
