/**
 * A EXCEÇÃO DA LINHA A NA ENTRADA (1.110.2).
 *
 * Com "valores e negociação com a equipe" ligada, quem pergunta o preço é
 * desviado para uma pessoa ANTES do roteador (`escalarComercialAntesDoModelo`).
 * Para o contato da Linha A — etiqueta `funil-a`, um negócio aberto no funil
 * Prospecção com `preco` — numa organização que ligou a opção, a mensagem segue
 * para a IA. Mede o handler de verdade, no mesmo arnês de
 * `restricao-comercial-cede-ao-opt-out.test.ts`, com a leitura REAL da camada e
 * da exceção contra um pool que responde por SQL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedAgentConfig } from '@/lib/agent-engine/agent/agent-config';

const mocks = vi.hoisted(() => ({
  router: vi.fn(),
  classify: vi.fn(),
  agente: vi.fn(),
  draft: vi.fn(),
  passagem: vi.fn(),
  aviso: vi.fn(),
  avisoLendo: vi.fn(),
  emHandoff: vi.fn(),
  leadContext: vi.fn(),
}));

vi.mock('@/lib/agent-engine/agent/router-config', () => ({ loadActiveRouter: mocks.router }));
vi.mock('@/lib/agent-engine/agent/intent-classifier', () => ({ classifyIntent: mocks.classify }));
vi.mock('@/lib/agent-engine/agent/agent-config', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadPublishedAgentConfigById: mocks.agente,
  loadPublishedAgentConfig: mocks.agente,
  loadConversationAgentConfig: mocks.agente,
}));
vi.mock('@/lib/agent-engine/agent/reply-drafts', () => ({ generateReplyDraft: mocks.draft }));
vi.mock('@/lib/atendimento/fronteira-server', () => ({
  currentExecutionBoundary: () => undefined,
  setExecutionAgentOperation: vi.fn(),
  guardServiceEffect: vi.fn(),
}));
vi.mock('@/lib/agent-engine/agent/human-handoff', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isLeadInHandoff: mocks.emHandoff,
  performHumanHandoff: mocks.passagem,
}));
vi.mock('@/lib/agent-engine/agent/aviso-de-escalacao', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  avisarLeadDaEscalacao: mocks.aviso,
  avisarLeadLendoOContato: mocks.avisoLendo,
}));
vi.mock('@/lib/agent-engine/cron/scheduler', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  cancelPendingCronsForLead: vi.fn(async () => 0),
}));
vi.mock('@/lib/agent-engine/edge/crm/get-lead-context', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLeadContext: mocks.leadContext,
}));
// Só o automático chega aqui: o turno monta o prompt antes das detecções.
vi.mock('@/lib/agent-engine/agent/playbook', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadPlaybook: vi.fn(async () => ({ prompt: '## Identidade\nTeste.', versionIds: {} })),
}));
vi.mock('@/lib/agent-engine/agent/fuso-da-org', () => ({ fusoDaOrganizacao: vi.fn(async () => 'UTC') }));
vi.mock('@/lib/ai/elegibilidade/consulta-pg', () => ({ decidirElegibilidadeDaConversa: vi.fn(async () => null) }));

import { createInboundTurnHandler, type InboundTurnDeps } from '@/lib/agent-engine/agent/inbound-turn';
import { OPCAO_EXCECAO_FUNIL_A } from '@/lib/escalacao/excecao-funil-a';

const ids = {
  org: '13100000-0000-4000-8000-000000000001', contact: '13100000-0000-4000-8000-000000000002',
  conversation: '13100000-0000-4000-8000-000000000003', channel: '13100000-0000-4000-8000-000000000004',
  job: '13100000-0000-4000-8000-000000000005',
};
const job = {
  id: ids.job, organization_id: ids.org, contact_id: ids.contact, kind: 'inbound_turn',
  payload: { conversation_id: ids.conversation, contact_id: ids.contact, channel_session_id: ids.channel,
    inbound_message_id: '13100000-0000-4000-8000-000000000006', crm_event_id: '13100000-0000-4000-8000-000000000007' },
};
const deps = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  llmCfg: {}, crmCfg: {}, knobs: {},
  // Relógio fixo DENTRO da janela anti-ban: com o relógio real, o turno do
  // automático é adiado à noite (antes das detecções) e o teste só passava de dia.
  clock: () => new Date('2026-10-21T15:00:00Z'),
  channel: () => ({ send: vi.fn(async () => ({ kind: 'sent' })) }),
} as unknown as InboundTurnDeps;
const assistido = {
  agentId: 'A', versionId: 'version-A', operationRevision: '7', operationMode: 'assisted',
  pausedAt: null, handoffKeywords: [],
} as unknown as PublishedAgentConfig;

type Cenario = { opcao: boolean | null; etiquetas: string[]; negocios: unknown[] };
const NEGOCIO = { funil_nome: 'Prospecção', funil_slug: 'prospeccao', campos: { preco: 'R$ 697', codigo: 'xjvx5klebf' } };
const LINHA_A: Cenario = { opcao: true, etiquetas: ['funil-a'], negocios: [NEGOCIO] };

function rodar(mensagem: string, c: Cenario) {
  mocks.leadContext.mockResolvedValue({
    ok: true, tokenCount: 12, lgpd: { isAnonymized: false },
    context: {
      lead_id: ids.contact, conversation_id: ids.conversation, last_human_decision: null,
      contact: { name: 'Cliente', phone: null, email: null, tags: c.etiquetas, is_blocked: false },
      messages: [{ direction: 'inbound', body: mensagem }],
    },
  });
  const leuNegocio = vi.fn();
  const pool = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('org_guardrail_layers')) {
        if (values?.[1] === OPCAO_EXCECAO_FUNIL_A) return { rows: c.opcao === null ? [] : [{ enabled: c.opcao }] };
        return { rows: [{ enabled: true }] };
      }
      if (sql.includes('from contacts c') && sql.includes('crm_leads l')) {
        leuNegocio(values);
        return { rows: [{ etiquetas: c.etiquetas, negocios: c.negocios }] };
      }
      if (sql.includes('from messages m')) return { rows: [{ body: mensagem }] };
      if (sql.includes('lead_checkpoints')) return { rows: [] };
      if (sql.includes('calendar_appointments')) return { rows: [] };
      return { rows: [{ active_ai_agent_id: null, active_intent: null, body: mensagem }] };
    }),
  };
  return { leuNegocio, turno: createInboundTurnHandler(deps)(job as never, pool as never, { workerId: 'w' }) };
}

const passagemComercial = () =>
  mocks.passagem.mock.calls.filter((c) => String((c[2] as { inboxTitle?: string })?.inboxTitle ?? '').startsWith('Valores e negociação'));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.router.mockResolvedValue(null);
  mocks.agente.mockResolvedValue(assistido);
  mocks.emHandoff.mockResolvedValue(false);
  mocks.aviso.mockResolvedValue({ avisado: true });
  mocks.avisoLendo.mockResolvedValue({ avisado: true });
  mocks.passagem.mockResolvedValue(undefined);
});

describe('exceção da Linha A na entrada: o preço segue para a IA', () => {
  it.each(['Quanto custa?', 'Qual o valor?', 'tá caro, tem desconto?', 'pode mandar o pix'])(
    'Linha A com a opção ligada: "%s" NÃO é desviada para a equipe', async (mensagem) => {
      const { turno, leuNegocio } = rodar(mensagem, LINHA_A);
      // O que se mede é o DESVIO, que roda antes do roteador. Passado ele, o turno
      // entra no redator (`executarTurnoDoAgente`), que este arnês não monta — o
      // erro de lá é do arnês, e não muda o que já foi decidido aqui.
      await turno.catch(() => undefined);
      expect(vi.mocked(deps.log.info).mock.calls.map((c) => c[0]))
        .toContain('assunto comercial na Linha A: segue para a IA (exceção funil-a)');
      expect(mocks.avisoLendo, 'o aviso comercial sai por avisarLeadLendoOContato').not.toHaveBeenCalled();
      expect(passagemComercial()).toEqual([]);
      expect(mocks.router, 'o turno seguiu até o roteador, que o desvio comercial antecede').toHaveBeenCalled();
      // a leitura filtra organização e contato de fonte confiável (o job)
      expect(leuNegocio).toHaveBeenCalledWith([ids.org, ids.contact]);
    });

  it('Linha A com a opção ligada: opt-out continua vencendo ("Parar mensagens")', async () => {
    await rodar('Parar mensagens', LINHA_A).turno;
    expect(passagemComercial()).toEqual([]);
    expect(mocks.passagem.mock.calls[0]?.[2]).toMatchObject({ reason: 'suspected_optout' });
    expect(mocks.draft).not.toHaveBeenCalled();
  });

  it.each<[string, Cenario]>([
    ['opção sem linha (o estado de todo deploy)', { ...LINHA_A, opcao: null }],
    ['opção com enabled=false', { ...LINHA_A, opcao: false }],
    ['contato sem a etiqueta funil-a', { ...LINHA_A, etiquetas: ['cliente'] }],
    ['sem negócio aberto na Prospecção', { ...LINHA_A, negocios: [] }],
    ['dois negócios abertos na Prospecção', { ...LINHA_A, negocios: [NEGOCIO, NEGOCIO] }],
    ['negócio sem preco', { ...LINHA_A, negocios: [{ ...NEGOCIO, campos: { codigo: 'x' } }] }],
  ])('%s: o desvio de sempre (passagem comercial antes do roteador)', async (_nome, cenario) => {
    const { turno, leuNegocio } = rodar('Quanto custa?', cenario);
    await turno;
    expect(mocks.avisoLendo).toHaveBeenCalledOnce();
    expect(mocks.avisoLendo.mock.calls[0]?.[2]).toMatchObject({ motivo: 'outro' });
    expect(passagemComercial()).toHaveLength(1);
    expect(mocks.router, 'a passagem comercial vem antes do roteador').not.toHaveBeenCalled();
    if (cenario.opcao !== true) expect(leuNegocio, 'opção desligada não lê contato nem negócio').not.toHaveBeenCalled();
  });
});
