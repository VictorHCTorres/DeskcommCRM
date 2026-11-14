/**
 * A TRAVA DO NÚMERO DE PROSPECÇÃO (Linha A, v20) — as regras puras e as duas leituras.
 */
import { describe, expect, it } from "vitest";

import { PACING_DEFAULTS, type PacingKnobs } from "@/lib/agent-engine/pacing/defaults";

import {
  ehFeriadoNacional,
  motivoDaHoraNoChip,
  motivoDaPessoaNoChip,
  paradasDoFiltro,
  proximaAberturaSemFeriado,
  travaDoChipPorPg,
  travaDoChipPorSupabase,
} from "./chip-de-prospeccao";
import { hashDoEndereco } from "./exclusoes";

const em = (dia: string, hhmm: string) => new Date(`${dia}T${hhmm}:00-03:00`);
const KNOBS: PacingKnobs = {
  ...PACING_DEFAULTS,
  timezone: "America/Fortaleza",
  windowStartHour: 8,
  windowEndHour: 18,
  prospeccaoDias: [1, 2, 3, 4, 5],
};
const CONTATO = { is_blocked: false, tags: ["funil-a"], force_human: false, ai_opt_out: false, consent: null, phone_number: "+5588900000000" };
const FILTRO = { com_todas_tags: ["fa-x"], sem_tags: ["sair", "parar", "tem-quem-cuide"] };

describe("a hora do número de prospecção vem da configuração", () => {
  it.each([
    ["2026-11-18", "08:00", null],
    ["2026-11-18", "07:59", "fora_da_janela_de_prospeccao"],
    ["2026-11-18", "17:59", null],
    ["2026-11-18", "18:00", "fora_da_janela_de_prospeccao"],
    ["2026-11-21", "10:00", "fora_da_janela_de_prospeccao"], // sábado fora dos dias
    ["2026-11-20", "08:00", "feriado_nacional"], // Consciência Negra
    ["2026-11-20", "10:30", "feriado_nacional"],
  ] as const)("%s às %s → %s", (dia, hhmm, esperado) => {
    expect(motivoDaHoraNoChip(em(dia, hhmm), KNOBS)).toBe(esperado);
  });

  it("controle: com a janela 9–18 (a configuração antiga), 8h00 é recusado — não há 9h no código", () => {
    expect(motivoDaHoraNoChip(em("2026-11-18", "08:00"), { ...KNOBS, windowStartHour: 9 })).toBe("fora_da_janela_de_prospeccao");
  });

  it("20/11/2026 é feriado nacional no fuso da operação, 19/11 não", () => {
    expect(ehFeriadoNacional(em("2026-11-20", "00:01"), "America/Fortaleza")).toBe(true);
    expect(ehFeriadoNacional(em("2026-11-19", "23:59"), "America/Fortaleza")).toBe(false);
  });

  it("⭐ a próxima abertura depois da quinta 19/11 às 18h pula o feriado de sexta e o fim de semana: segunda 23/11 às 8h", () => {
    expect(proximaAberturaSemFeriado(em("2026-11-19", "18:30"), KNOBS).toISOString()).toBe(em("2026-11-23", "08:00").toISOString());
  });
});

describe("a pessoa no número de prospecção", () => {
  const paradas = paradasDoFiltro([FILTRO, null, { sem_tags: ["sem-interesse", 3] }]);
  it("as etiquetas de parada são as de todas as campanhas de prospecção do número", () => {
    expect(paradas.sort()).toEqual(["parar", "sair", "sem-interesse", "tem-quem-cuide"]);
  });
  it.each([
    [{ is_blocked: true }, "contato_bloqueado"],
    [{ tags: ["funil-a", "sair"] }, "etiqueta_de_parada"],
    [{ tags: ["tem-quem-cuide"] }, "etiqueta_de_parada"],
    [{ force_human: true }, "atendimento_humano"],
    [{ ai_opt_out: true }, "atendimento_humano"],
    [{ consent: { marketing: { granted: false } } }, "recusou_marketing"],
    [{}, null],
  ] as const)("%o → %s", (mudar, esperado) => {
    expect(motivoDaPessoaNoChip({ ...CONTATO, ...mudar } as never, paradas)).toBe(esperado);
  });
});

/** Um banco de mentira para a leitura por conexão: responde por padrão de SQL. */
function bancoPg(opcoes: { campanha?: boolean; contato?: Partial<typeof CONTATO>; semContato?: boolean; lista?: boolean; comPessoa?: boolean; falha?: RegExp } = {}) {
  const consultas: string[] = [];
  return {
    consultas,
    query: async (sql: string) => {
      consultas.push(sql);
      if (opcoes.falha?.test(sql)) throw new Error("banco fora do ar");
      if (/from campaigns k/.test(sql)) {
        return { rows: opcoes.campanha === false ? [] : [{ marca_da_prospeccao: "prospeccao", audience_filter: FILTRO }] };
      }
      if (/join channel_knobs/.test(sql)) {
        return {
          rows: [{ throttle_ms: 1200, jitter_max_ms: 800, window_start_hour: 8, window_end_hour: 18, allow_sunday: false,
            prospeccao_dias: [1, 2, 3, 4, 5], timezone: "America/Fortaleza", warmup_daily_caps: null, number_activated_at: null }],
        };
      }
      if (/from contacts/.test(sql)) return { rows: opcoes.semContato ? [] : [{ ...CONTATO, ...(opcoes.contato ?? {}) }] };
      if (/from campaign_suppressions/.test(sql)) return { rows: opcoes.lista ? [{ "?column?": 1 }] : [] };
      if (/from conversations/.test(sql)) return { rows: opcoes.comPessoa ? [{ "?column?": 1 }] : [] };
      return { rows: [] };
    },
  };
}
const ALVO = { organizationId: "org-1", channelSessionId: "00000000-0000-4000-8000-000000005286", contactId: "00000000-0000-4000-8000-0000000000aa" };

describe("a leitura por conexão (a cadeia do agente e o resgate)", () => {
  it("número que não é de prospecção: não confere mais nada", async () => {
    const db = bancoPg({ campanha: false });
    expect(await travaDoChipPorPg(db, ALVO, em("2026-11-20", "10:00"))).toBeNull();
    expect(db.consultas).toHaveLength(1);
  });
  it("⭐ a linha sem a marca (um dublê que devolve qualquer coisa) não faz do número um número de prospecção", async () => {
    const db = { query: async () => ({ rows: [{ id: "x" }] }) };
    expect(await travaDoChipPorPg(db, ALVO, em("2026-11-20", "10:00"))).toBeNull();
  });
  it("⭐ feriado 20/11: recusa com a próxima abertura (segunda 23/11, 8h)", async () => {
    const r = await travaDoChipPorPg(bancoPg(), ALVO, em("2026-11-20", "10:00"));
    expect(r).toEqual({ motivo: "feriado_nacional", proximaAbertura: em("2026-11-23", "08:00") });
  });
  it("⭐ 7h59 recusa; 8h00 passa", async () => {
    expect((await travaDoChipPorPg(bancoPg(), ALVO, em("2026-11-18", "07:59")))?.motivo).toBe("fora_da_janela_de_prospeccao");
    expect(await travaDoChipPorPg(bancoPg(), ALVO, em("2026-11-18", "08:00"))).toBeNull();
  });
  it.each([
    [{ contato: { is_blocked: true } }, "contato_bloqueado"],
    [{ contato: { tags: ["sair"] } }, "etiqueta_de_parada"],
    [{ lista: true }, "suprimido"],
    [{ comPessoa: true }, "atendimento_humano"],
    [{ falha: /from contacts/ }, "sem_leitura"],
    [{ falha: /from campaigns k/ }, "sem_leitura"],
  ] as const)("⭐ a pessoa: %o → %s", async (opcoes, motivo) => {
    expect((await travaDoChipPorPg(bancoPg(opcoes as never), ALVO, em("2026-11-18", "10:00")))?.motivo).toBe(motivo);
  });
  it("⭐ o contato que não se acha não deixa sair (sem_leitura)", async () => {
    expect((await travaDoChipPorPg(bancoPg({ semContato: true }), ALVO, em("2026-11-18", "10:00")))?.motivo).toBe("sem_leitura");
  });
  it("`hora: false` pula a hora e confere a pessoa", async () => {
    expect(await travaDoChipPorPg(bancoPg(), ALVO, em("2026-11-20", "10:00"), { hora: false })).toBeNull();
    expect((await travaDoChipPorPg(bancoPg({ contato: { is_blocked: true } }), ALVO, em("2026-11-20", "10:00"), { hora: false }))?.motivo).toBe(
      "contato_bloqueado",
    );
  });
});

/** O PostgREST de mentira para a leitura do handler. */
function postgrest(tabelas: Record<string, Array<Record<string, unknown>>>, falhas: string[] = []) {
  return {
    from(tabela: string) {
      const filtros: Array<(l: Record<string, unknown>) => boolean> = [];
      const resolver = async () =>
        falhas.includes(tabela)
          ? { data: null, error: { message: "falhou" } }
          : { data: (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l))), error: null };
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), b),
        in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), b),
        limit: () => b,
        maybeSingle: async () => {
          const r = await resolver();
          return { data: r.data?.[0] ?? null, error: r.error };
        },
        then: (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) => resolver().then(ok, erro),
      };
      return b;
    },
  } as never;
}

describe("a leitura pelo PostgREST (o handler de mensagens)", () => {
  const base = (mudar: Record<string, Array<Record<string, unknown>>> = {}) => ({
    campaigns: [{ id: "k1", organization_id: "org-1", channel_session_id: ALVO.channelSessionId, base_legal: "legitimate_interest", status: "completed", audience_filter: FILTRO }],
    campaign_channel_sessions: [],
    channel_knobs: [{ organization_id: "org-1", channel_session_id: ALVO.channelSessionId, window_start_hour: 8, window_end_hour: 18, allow_sunday: false, prospeccao_dias: [1, 2, 3, 4, 5], timezone: "America/Fortaleza" }],
    organizations: [{ id: "org-1", timezone: "America/Fortaleza" }],
    contacts: [{ id: ALVO.contactId, organization_id: "org-1", ...CONTATO }],
    campaign_suppressions: [],
    conversations: [],
    ...mudar,
  });
  it("⭐ campanha concluída ainda faz do número um número de prospecção: o feriado recusa", async () => {
    expect((await travaDoChipPorSupabase(postgrest(base()), ALVO, em("2026-11-20", "10:00")))?.motivo).toBe("feriado_nacional");
  });
  it("⭐ pelo rodízio (`campaign_channel_sessions`) também", async () => {
    const t = base({
      campaigns: [{ id: "k2", organization_id: "org-1", channel_session_id: "outro", base_legal: "legitimate_interest", status: "running", audience_filter: FILTRO }],
      campaign_channel_sessions: [{ organization_id: "org-1", campaign_id: "k2", channel_session_id: ALVO.channelSessionId }],
    });
    expect((await travaDoChipPorSupabase(postgrest(t), ALVO, em("2026-11-18", "07:59")))?.motivo).toBe("fora_da_janela_de_prospeccao");
  });
  it("controle: só campanha de consentimento ou rascunho no número — não é de prospecção", async () => {
    const t = base({
      campaigns: [
        { id: "k3", organization_id: "org-1", channel_session_id: ALVO.channelSessionId, base_legal: "consent", status: "running", audience_filter: FILTRO },
        { id: "k4", organization_id: "org-1", channel_session_id: ALVO.channelSessionId, base_legal: "legitimate_interest", status: "draft", audience_filter: FILTRO },
      ],
    });
    expect(await travaDoChipPorSupabase(postgrest(t), ALVO, em("2026-11-20", "10:00"))).toBeNull();
  });
  it("⭐ etiqueta `tem-quem-cuide` às 10h de quarta: recusa", async () => {
    const t = base({ contacts: [{ id: ALVO.contactId, organization_id: "org-1", ...CONTATO, tags: ["tem-quem-cuide"] }] });
    expect((await travaDoChipPorSupabase(postgrest(t), ALVO, em("2026-11-18", "10:00")))?.motivo).toBe("etiqueta_de_parada");
  });
  it("⭐ conversa aberta com atendente: recusa", async () => {
    const t = base({ conversations: [{ organization_id: "org-1", contact_id: ALVO.contactId, status: "open", assigned_to_user_id: "u1", bot_silenced_until: null }] });
    expect((await travaDoChipPorSupabase(postgrest(t), ALVO, em("2026-11-18", "10:00")))?.motivo).toBe("atendimento_humano");
  });
  it("⭐ conversa ENCERRADA com o dono antigo gravado: não barra (é histórico)", async () => {
    const t = base({ conversations: [{ organization_id: "org-1", contact_id: ALVO.contactId, status: "closed", assigned_to_user_id: "u1", bot_silenced_until: null }] });
    expect(await travaDoChipPorSupabase(postgrest(t), ALVO, em("2026-11-18", "10:00"))).toBeNull();
  });
  it("⭐ sem ler a campanha: recusa (falha fechada)", async () => {
    expect((await travaDoChipPorSupabase(postgrest(base(), ["campaigns"]), ALVO, em("2026-11-18", "10:00")))?.motivo).toBe("sem_leitura");
  });
  it("controle: quarta às 10h, pessoa livre: passa", async () => {
    expect(await travaDoChipPorSupabase(postgrest(base()), ALVO, em("2026-11-18", "10:00"))).toBeNull();
  });
  it("⭐ o telefone do contato na lista de exclusão: recusa", async () => {
    const t = base({ campaign_suppressions: [{ organization_id: "org-1", recipient_address_hash: hashDoEndereco(CONTATO.phone_number) }] });
    expect((await travaDoChipPorSupabase(postgrest(t), ALVO, em("2026-11-18", "10:00")))?.motivo).toBe("suprimido");
  });
  it("⭐ uma leitura que LANÇA (e não devolve `error`) não deixa sair", async () => {
    const quebrado = { from: (t: string) => { if (t === "contacts") throw new Error("cliente quebrado"); return (postgrest(base()) as { from: (x: string) => unknown }).from(t); } } as never;
    expect((await travaDoChipPorSupabase(quebrado, ALVO, em("2026-11-18", "10:00")))?.motivo).toBe("sem_leitura");
  });
});
