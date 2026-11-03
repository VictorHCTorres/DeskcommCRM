import { describe, expect, it } from "vitest";

import { filtroDeTarefasDoTitular } from "./task-scope";

describe("escopo LGPD das tarefas", () => {
  it("inclui contact-only e os leads do titular sem duplicar IDs", () => {
    expect(filtroDeTarefasDoTitular("contact-1", [])).toBe("contact_id.eq.contact-1");
    expect(filtroDeTarefasDoTitular("contact-1", ["lead-1", "lead-1", "lead-2"])).toBe(
      'contact_id.eq.contact-1,lead_id.in.("lead-1","lead-2")',
    );
  });
});
