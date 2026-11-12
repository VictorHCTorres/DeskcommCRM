/**
 * Watchdog de sessão (Fase 4A-2) — o pedaço do Vendaval que ficou de fora do
 * porte e cuja falta causou o incidente real das mensagens presas: o webhook
 * session.status se perde num restart e o espelho `channel_sessions` diverge do
 * WAHA real; como o envio exige WORKING no espelho, respostas ficam `queued`
 * para sempre.
 *
 * Três deveres, um tick:
 *   1. RECONCILIADOR: lê o status REAL das sessões na API do WAHA e corrige o
 *      espelho quando divergir (a fonte da verdade do status é o WAHA);
 *   2. RETOMA: sessão STOPPED que ainda é nossa (não arquivada) volta a subir.
 *      Restart de container, OOM e sono do Docker deixam a credencial no disco
 *      e a sessão parada — o envio exige WORKING, então inbound e auto-resposta
 *      morrem até alguém clicar Reconectar. FAILED não entra: pode ser banimento,
 *      e religar sozinho piora; SCAN_QR_CODE também não — tem gente no celular.
 *   3. REDRIVE: mensagens `sent_via in ('ai','automation','system')` presas em `queued` cuja sessão está
 *      WORKING são reenviadas pelo WAHA (com espaçamento anti-rajada) e marcadas
 *      `sent`. Só linhas ainda `queued` entram, então nada é reenviado duas vezes
 *      pelo mesmo caminho — e, desde 14/09/2026, o eco da mensagem reenviada não
 *      fica duplicado na conversa nem prende a mensagem em `queued` (ver
 *      `markRedriveSent` e `removeRedriveEcho`). Antes esta linha dizia "nunca
 *      duplicadas", e o eco provava o contrário.
 *
 * Regra dura nº 4 respeitada: message-plane nunca fala com o WAHA — este módulo
 * é o WATCHDOG (admin-plane), o único lugar do engine autorizado a falar com o
 * WAHA diretamente (o envio normal segue via sendMessageHandler).
 */
import type pg from 'pg';

import { canonicalWahaExternalId, chatIdFromWaMessageId, parseWahaMessageId, wahaEchoExternalIds } from '@/lib/waha/message-id';
import { chatIndividualDaMensagem } from '@/lib/waha/ultima-recebida';
import { lerNumerosDeTeste, numeroPodeTestar, preGoLiveAtivo } from '@/lib/ai/elegibilidade/pre-go-live';
import { canalDesativado } from '@/lib/channels/desativado';
import { canalTemRiscoDeBanimento } from '@/lib/channels/capabilities';
import { podeMandarAgora, type RitmoDaCampanha } from '@/lib/campanhas/ritmo';

import { regraDoStop, vereditoDoStop, type LinhaDoStop, type MotivoDoStop } from '../../guardrails/before-send';
import type { Logger } from '../../obs/logger';
import type { PacingKnobs } from '../../pacing/defaults';
import { dayStartInTz, janelaDeEnvioAberta, tetoDoDia } from '../../pacing/engine';
import { loadChannelKnobs, reservarVagaRelida, undoSend, type ReservaDaVaga } from '../../pacing/store';
import { KINDS_DE_RESPOSTA, type Queryable } from '../../queue/queue';

export interface WatchdogConfig {
  wahaBaseUrl: string;
  wahaApiKey: string;
  /** intervalo do tick (knob WATCHDOG_INTERVAL_MS) */
  intervalMs: number;
  /** idade mínima de uma queued para redrive — evita corrida com o insert do handler */
  redriveMinAgeMs: number;
  /** teto de redrives por tick (anti-rajada) */
  redriveBatchSize: number;
  /** espaçamento entre redrives (base + jitter) */
  redriveSpacingMs: number;
}

interface WahaSession {
  name: string;
  status: string;
}

/**
 * Só STOPPED: a credencial no disco ainda vale e o start a reaproveita.
 * FAILED pode ser banimento — religar sozinho é o que o vigia de saúde recusa.
 * SCAN_QR_CODE tem alguém no celular; STARTING já está subindo.
 */
export function deveRetomarSessao(status: string): boolean {
  return status.toUpperCase() === 'STOPPED';
}

async function startWahaSession(cfg: WatchdogConfig, name: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${cfg.wahaBaseUrl}/api/sessions/${encodeURIComponent(name)}/start`,
      {
        method: 'POST',
        headers: { 'X-Api-Key': cfg.wahaApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15_000),
      },
    );
    // 422/409 = já está subindo ou WORKING — o efeito que queremos.
    return res.ok || res.status === 422 || res.status === 409;
  } catch {
    return false;
  }
}

async function fetchWahaSessions(cfg: WatchdogConfig): Promise<WahaSession[] | null> {
  try {
    const res = await fetch(`${cfg.wahaBaseUrl}/api/sessions?all=true`, {
      headers: { 'X-Api-Key': cfg.wahaApiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as WahaSession[];
    return Array.isArray(data) ? data : null;
  } catch {
    return null; // WAHA fora: tick pula (transiente) — nunca derruba o worker
  }
}

/** Corrige o espelho channel_sessions para o status REAL do WAHA e retoma STOPPED. */
export async function reconcileSessions(
  pool: pg.Pool,
  cfg: WatchdogConfig,
  log: Logger,
): Promise<number> {
  const sessions = await fetchWahaSessions(cfg);
  if (sessions === null) {
    log.warn('watchdog: WAHA indisponível — tick de reconciliação pulado', {});
    return 0;
  }
  let fixed = 0;
  for (const s of sessions) {
    const wahaStatus = (s.status ?? '').toUpperCase();
    // Arquivada não é nossa: a exclusão desloga o aparelho. Uma sessão STOPPED
    // órfã no transporte não pode voltar a receber mensagem num canal que a UI
    // já não mostra.
    const { rows: nossas } = await pool.query<{ id: string; status: string }>(
      // `to_jsonb(cs) ->> 'archived_at'` em vez de `cs.archived_at`, como em
      // `agent/followup-turn.ts:254` e pelo mesmo motivo: a coluna nasce na
      // migration 0106 e, num clone que subiu o código sem aplicá-la,
      // referenciá-la direto derruba o tick INTEIRO com 42703 — levando junto o
      // redrive das mensagens em fila, que roda depois desta função.
      `select cs.id, cs.status from channel_sessions cs
       where cs.waha_session_name = $1 and to_jsonb(cs) ->> 'archived_at' is null`,
      [s.name],
    );
    if (nossas.length === 0) continue;

    let nextStatus = wahaStatus;
    if (deveRetomarSessao(wahaStatus)) {
      const started = await startWahaSession(cfg, s.name);
      if (started) {
        nextStatus = 'STARTING';
        // O info sai só quando o espelho REALMENTE muda (logo abaixo, no
        // `returning`). Aqui ele sairia a cada tick de 60 s enquanto a sessão
        // continuasse parada — 1440 linhas por dia repetindo a mesma boa
        // notícia é o caminho mais curto para o operador parar de ler o log.
      }
    }

    // ZERO LINHAS PARA ESCREVER NÃO É UMA ESCRITA (#3695). O `where` abaixo já
    // traz `status is distinct from $2`, então o banco devolvia 0 linhas — mas a
    // INSTRUÇÃO era emitida assim mesmo a cada tick de ~30 s (274 vezes em 2h19
    // medidas na issue), com parse, plano e varredura para não mudar nada. A
    // leitura acima já responde a mesma pergunta: `nossas` é EXATAMENTE o
    // conjunto que o `where` alcança (mesmo `waha_session_name`, mesmo
    // `archived_at is null`). O `is distinct from` continua no `where` como
    // trava de corrida: outra instância pode ter mudado a linha entre o select
    // e o update.

    if (nossas.every((nossa) => nossa.status === nextStatus)) continue;

    const { rows } = await pool.query<{ id: string; status: string }>(
      `update channel_sessions
          set status = $2, updated_at = now()
        where waha_session_name = $1
          and to_jsonb(channel_sessions) ->> 'archived_at' is null
          and status is distinct from $2
       returning id, status`,
      [s.name, nextStatus],
    );
    for (const row of rows) {
      fixed += 1;
      log.warn('watchdog: espelho de sessão reconciliado com o WAHA real', {
        channel_session_id: row.id,
        waha_session: s.name,
        status: nextStatus,
      });
    }
  }
  return fixed;
}

interface QueuedRow {
  id: string;
  organization_id: string;
  /** A limpeza do eco só procura na conversa da própria mensagem. */
  conversation_id: string;
  /** Ficha da mensagem: a regra do telefone extra parte dela. */
  contact_id: string | null;
  body: string | null;
  waha_session_name: string;
  wa_identity: string | null;
  wa_lid: string | null;
  phone_number: string | null;
  is_group: boolean;
  group_chat_id: string | null;
  /** De onde veio a mensagem: a de campanha leva `source` e `campaign_id` (F4i). */
  metadata: unknown;
  /** O número que manda: a vaga no limite diário é dele (F4p do cxj, P07). */
  channel_session_id: string;
  /**
   * O canal, para a regra da vaga. O teto do CRM do número não vem daqui: a reserva o lê sob a
   * trava (F4r do cxj, R05).
   */
  provider: string | null;
  /** Quem escreveu: a mensagem da IA (`ai`) passa pela mesma parada da cadeia (F4r do cxj, R06). */
  sent_via: string;
  /**
   * A mensagem respondia a quem escreveu: o job da chave dela no `send_ledger` é um dos
   * `KINDS_DE_RESPOSTA` (F4q do cxj, Q08). Sem o job (automação, sistema, linha antiga), `false`.
   */
  resposta: boolean;
}

/**
 * A mensagem presa sem job vivo (F4r do cxj, R08): nenhum job pendente ou em execução tem a chave
 * dela no `send_ledger` (`l.id = m.id`, a mesma ligação de `resposta`). Fragmento de SQL sobre o
 * alias `m` de `messages`, na consulta do resgate e na releitura de `conferirElegibilidade`.
 */
const SEM_JOB_VIVO = `not exists (
         select 1 from send_ledger l
         join job_queue j on j.id = l.job_id and j.organization_id = l.organization_id
         where l.organization_id = m.organization_id and l.id = m.id
           and j.status in ('pending', 'running'))`;

/** O que a mensagem da IA que não sai pela parada da cadeia (F4r do cxj, R06) grava como erro. */
const ERRO_DA_PARADA: Record<MotivoDoStop, string> = {
  atendimento_com_humano: 'Não reenviada: a conversa passou para o atendimento humano.',
  contato_bloqueado: 'Não reenviada: o contato não recebe mensagens automáticas.',
  contato_interno: 'Não reenviada: o contato é interno.',
};

/**
 * A campanha da mensagem presa, pelo `metadata` que a rodada grava. `null`
 * quando não é de campanha; `''` quando é de campanha sem o id (a busca não
 * acha nada, e a falta conta como prospecção: falha fechada).
 */
export function campanhaDaMensagem(metadata: unknown): string | null {
  const meta = metadata as { source?: unknown; campaign_id?: unknown } | null | undefined;
  if (meta?.source !== 'campaign') return null;
  return typeof meta.campaign_id === 'string' ? meta.campaign_id : '';
}

/**
 * chatId do WAHA a partir da identidade do contato — MESMA REGRA de
 * `resolveWahaChatId` (lib/waha/send.ts), e as duas precisam continuar iguais:
 * este caminho reenvia o que aquele deixou preso, e divergir aqui faria o
 * redrive mandar a mensagem para um endereço diferente do envio original.
 *
 * `wa_lid` na frente pelo motivo da 0122: `wa_identity` é GERADA com o telefone
 * antes do lid, então o contato @lid que ganhou número passa a bater na linha do
 * `phone:` e a conversa mudaria de canal no reenvio.
 *
 * `ultimoRecebido` é o chat da última mensagem recebida, só quando a ficha tem
 * telefone extra (`ultimaRecebidaDaFicha`). Vem logo depois do grupo, como em
 * `resolveWahaChatId`: sem isso o reenvio sairia pelo principal.
 */
function chatIdOf(m: QueuedRow, ultimoRecebido: string | null): string | null {
  if (m.is_group && m.group_chat_id) return m.group_chat_id;
  if (ultimoRecebido) return ultimoRecebido;
  if (m.wa_lid) return `${m.wa_lid}@lid`;
  if (m.wa_identity?.startsWith('lid:')) return `${m.wa_identity.slice(4)}@lid`;
  if (m.wa_identity?.startsWith('phone:+')) return `${m.wa_identity.slice(7)}@c.us`;
  if (m.phone_number) return `${m.phone_number.replace('+', '')}@c.us`;
  return null;
}

/**
 * O chat da última mensagem RECEBIDA da conversa, quando a ficha tem telefone
 * extra. MESMA REGRA de `chatIdDaUltimaRecebida` (lib/waha/ultima-recebida.ts),
 * em SQL, porque este processo tem só o `pg` cru. Ficha sem extra devolve null
 * depois de UMA consulta barata e a regra de sempre segue.
 *
 * Qualquer erro vira null com `warn`: o reenvio não pode parar por isso.
 */
async function ultimaRecebidaDaFicha(
  pool: pg.Pool,
  m: QueuedRow,
  log: Logger,
): Promise<string | null> {
  if (m.is_group || !m.contact_id) return null;
  try {
    const { rows: extras } = await pool.query(
      `select 1 from contact_phones
       where organization_id = $1 and contact_id = $2
       limit 1`,
      [m.organization_id, m.contact_id],
    );
    if (extras.length === 0) return null;
    const { rows: recebidas } = await pool.query<{ external_id: string | null }>(
      `select external_id from messages
       where organization_id = $1 and conversation_id = $2
         and direction = 'inbound' and external_id is not null
       order by created_at desc
       limit 1`,
      [m.organization_id, m.conversation_id],
    );
    const externalId = recebidas[0]?.external_id;
    if (!externalId) return null;
    return chatIndividualDaMensagem(chatIdFromWaMessageId(externalId));
  } catch (err) {
    // Só a organização no log: o chat e o contato carregam telefone.
    log.warn('watchdog: endereço da última recebida indisponível; segue pela regra de hoje', {
      organization_id: m.organization_id,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
    return null;
  }
}

/**
 * Marca `sent` a mensagem que o WAHA acabou de aceitar.
 *
 * O id é gravado na FORMA CANÔNICA, a mesma que o eco grava
 * (`canonicalWahaExternalId`: a cauda em conversa individual, desde o #1855; o
 * id intacto em grupo): só assim o `unique (organization_id, external_id)`
 * enxerga a colisão e devolve `23505`. No NOWEB a resposta de envio já é a cauda e nada
 * muda; no WEBJS ela vem como `_serialized` e, gravada aqui, nunca colidia com
 * o eco — a segunda linha nascia sem que este tratamento chegasse a rodar.
 *
 * Devolve `true` quando o id NÃO pôde ser gravado porque o eco dela já o ocupa.
 * Antes, essa recusa caía no `catch` do laço como "erro transiente — mantida
 * queued", e o cliente recebia a mesma mensagem de novo a cada tick — a
 * armadilha medida na issue #196 do DeskcommCRM. Aqui a mensagem sai `sent` sem
 * o id, e quem o grava é `stampExternalIdAfterEcho`, depois que o eco sai.
 *
 * Qualquer outro erro sobe como antes: sem conseguir escrever no banco, não há
 * como marcar nada daqui.
 */
async function markRedriveSent(
  pool: pg.Pool,
  m: QueuedRow,
  externalId: string | null,
): Promise<boolean> {
  const canonico = externalId === null ? null : canonicalWahaExternalId(externalId);
  try {
    await pool.query(
      `update messages
       set status = 'sent', ack = 0,
           external_id = coalesce($2, external_id),
           metadata = metadata || '{"redrive":"watchdog"}'::jsonb
       where id = $1 and organization_id = $3 and status = 'queued'`,
      [m.id, canonico, m.organization_id],
    );
    return false;
  } catch (err) {
    if ((err as { code?: unknown }).code !== '23505') throw err;
    await pool.query(
      `update messages
       set status = 'sent', ack = 0,
           metadata = metadata || '{"redrive":"watchdog"}'::jsonb
       where id = $1 and organization_id = $2 and status = 'queued'`,
      [m.id, m.organization_id],
    );
    return true;
  }
}

/**
 * Apaga a linha que o webhook criou para o eco desta mensagem reenviada.
 *
 * O escopo é o mesmo, e deliberadamente estreito, da limpeza do envio normal:
 * mesma organização, mesma conversa, só o que veio do celular
 * (`external_device`) e nunca a própria linha. O id cru do WhatsApp pode colidir
 * entre mensagens diferentes; restringir à conversa mantém o estrago de uma
 * colisão no único lugar onde ela seria de fato esta mensagem.
 *
 * BLINDADO: a mensagem já saiu e já está `sent`. Não conseguir apagar deixa a
 * duplicata na tela, que é o mundo de antes desta função — deixar a exceção
 * subir faria o laço registrar como falha uma entrega que deu certo.
 */
async function removeRedriveEcho(
  pool: pg.Pool,
  m: QueuedRow,
  externalId: string,
  chatId: string,
  log: Logger,
): Promise<void> {
  try {
    await pool.query(
      `delete from messages
       where organization_id = $1
         and conversation_id = $2
         and sent_via = 'external_device'
         and external_id = any($3::text[])
         and id <> $4`,
      [m.organization_id, m.conversation_id, wahaEchoExternalIds(externalId, chatId), m.id],
    );
  } catch (err) {
    log.warn('watchdog: não consegui remover o eco da mensagem reenviada', {
      message_id: m.id,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }
}

/**
 * Grava o id que o eco ocupava, agora que o eco saiu.
 *
 * Sem o id, o `message.ack` do webhook nunca encontra a linha e a mensagem trava
 * em `sent`: sem entregue, sem lida. `external_id is null` garante que isto nunca
 * sobrescreve um id que outro caminho já gravou.
 *
 * A FORMA É A CANÔNICA (`canonicalWahaExternalId`) pela mesma razão do carimbo
 * do envio: é a string que o eco grava, e só gravando a MESMA string é que o
 * `unique (organization_id, external_id)` recusa uma segunda linha quando outro
 * eco entra aqui. No NOWEB o id do envio já era a cauda — nada muda; no WEBJS o
 * `_serialized` gravado aqui nunca colidia com o eco.
 *
 * BLINDADO pelo mesmo motivo de `removeRedriveEcho`. Se o eco não saiu (a remoção
 * falhou), o unique recusa de novo e a mensagem fica `sent` sem id: sem ack e com
 * a duplicata na tela — mas sem reenvio.
 */
async function stampExternalIdAfterEcho(
  pool: pg.Pool,
  m: QueuedRow,
  externalId: string,
  log: Logger,
): Promise<void> {
  try {
    await pool.query(
      `update messages set external_id = $2
       where id = $1 and organization_id = $3 and external_id is null`,
      [m.id, canonicalWahaExternalId(externalId), m.organization_id],
    );
  } catch (err) {
    log.warn('watchdog: mensagem reenviada ficou sem id — o eco ainda o ocupa', {
      message_id: m.id,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }
}

/**
 * A folga da vaga do resgate (F4t do cxj, T03): quanto o envio pode sair depois da hora gravada na
 * vaga. A vaga leva a hora lida sob a trava, e o envio sai depois da última conferência; com a
 * conferência lenta (30 s, no teste do cxj), a vaga ficava 30 s mais velha que o envio, e a reserva
 * seguinte, conferida contra ela, passava no intervalo do número com o envio de verdade a 4 s do
 * anterior. Agora a vaga mais velha que a folga não sai (volta, e a mensagem espera o tique
 * seguinte), e a reserva do resgate pede o intervalo do número mais a folga: com o envio até a folga
 * depois da vaga, o seguinte nunca sai a menos do intervalo. Entre a hora da vaga e o envio há só a
 * releitura da regra, a gravação e a última conferência, leituras de milissegundos; 2 s é folga
 * para a leitura lenta, e o espaçamento do resgate (4 s a 8 s) segue maior que o intervalo padrão
 * (1,2 s) mais a folga.
 *
 * Versão 16 (F4u do cxj, U02): a garantia acima valia entre duas vagas do resgate. A resposta da IA
 * media o intervalo a partir da hora gravada na vaga, e saía a 3,1 s do envio do resgate, com o
 * intervalo em 5 s. Agora a vaga grava a hora mais tardia do envio, o instante mais a folga
 * (`RegraDaVaga.folgaMs`), e todo emissor do número mede o intervalo dela. A reserva segue pedindo o
 * intervalo mais a folga: a cadeia da IA grava o registro antes do transporte, e a margem cobre o
 * tempo entre o registro dela e a saída. Entre duas vagas do resgate, o intervalo efetivo passa a ser
 * o do número mais duas folgas (5,2 s no padrão): com o espaçamento de 4 s a 8 s, a mensagem que
 * cair antes disso espera o tique seguinte.
 *
 * Versão 17 (F4v do cxj, V01): a margem da reserva cobria o tempo entre o registro da IA e a saída
 * dela só até 2 s, e em produção esse caminho leva de 2 s a 8 s. Agora o registro da IA também
 * guarda a hora mais tardia da saída enquanto o transporte está em curso, com a idade conferida no
 * último passo do handler (`pacing/saida-do-agente.ts`), e vai para a hora em que o transporte voltou
 * quando ele confirma. A margem da reserva deixou de ser a cobertura desse tempo, e foi mantida.
 */
export const ATRASO_MAXIMO_DA_VAGA_DO_RESGATE_MS = 2_000;

/**
 * Reserva a vaga de uma saída do resgate no limite diário do número (F4p do cxj, P07), com a
 * mesma regra da campanha (`rodada.ts`): o teto do dia (`tetoDoDia`: o aquecimento e o teto do
 * CRM) e o intervalo do número (o throttle, sem o jitter), conferidos e gravados por
 * `reservarVaga`, sob a trava do número que a cadeia do agente e a campanha também usam. A
 * resposta presa reserva como resposta (F4q do cxj, Q08): conta no intervalo e não confere o teto
 * do dia, como a cadeia faz com a resposta.
 *
 * A regra é lida SOB a trava, dentro da transação da reserva (`reservarVagaRelida`; F4r do cxj, R05
 * e R07): os knobs do número (o aquecimento, o intervalo, o fuso e a janela) e o limite diário do
 * CRM. Lidos antes da espera pela trava, o limite baixado nessa espera não valia. E a janela do
 * tipo da mensagem (a de resposta ou a de disparo, `janelaDeEnvioAberta`, a mesma conta da cadeia)
 * tem de estar aberta: fechada, nada é reservado (`fora_da_janela`), e a mensagem espera na fila
 * o tique que a encontrar aberta. Antes, a resposta presa saía às 3h.
 *
 * O instante da vaga é o do relógio lido SOB a trava (F4s do cxj, S01): é com ele que a janela, o
 * teto e o intervalo contam. A linha leva o instante mais a folga, a hora mais tardia do envio
 * (versão 16, F4u do cxj, U02). A reserva devolve o instante e a folga (a devolução da vaga procura
 * a linha por eles), os knobs lidos e a janela da campanha da mensagem, com que quem chama confere
 * as janelas de novo logo antes do envio.
 */
async function reservarVagaDoResgate(
  pool: pg.Pool,
  m: QueuedRow,
  relogio: () => Date,
  log: Logger,
): Promise<VagaDoResgate> {
  const banRisk = canalTemRiscoDeBanimento(m.provider);
  // `reler` roda sob a trava antes de qualquer gravação: a vaga reservada sempre passou por ele.
  let lido!: { instante: Date; knobs: PacingKnobs; folgaMs: number; janelaDaCampanha: JanelaDaCampanha | null };
  const desfecho = await reservarVagaRelida<'fora_da_janela' | 'fora_da_janela_da_campanha'>(
    pool,
    m.organization_id,
    m.channel_session_id,
    relogio,
    { vagas: 1, resposta: m.resposta },
    async (db, instante) => {
      const { knobs, numberActivatedAt } = await loadChannelKnobs(db, m.organization_id, m.channel_session_id, log);
      if (!janelaDeEnvioAberta(instante, knobs, m.resposta)) return 'fora_da_janela';
      // A janela da própria campanha, a mesma que a rodada confere (F4u do cxj, U01).
      const janelaDaCampanha = await lerJanelaDaCampanha(db, m, knobs, log);
      if (janelaDaCampanha === 'sem_campanha' || (janelaDaCampanha && !janelaDaCampanhaAberta(janelaDaCampanha, instante)))
        return 'fora_da_janela_da_campanha';
      const { rows } = await db.query<{ daily_message_limit: number | null }>(
        'select daily_message_limit from channel_sessions where organization_id = $1 and id = $2',
        [m.organization_id, m.channel_session_id],
      );
      const comIntervalo = banRisk && knobs.throttleMs > 0;
      // A folga vale só com intervalo no número (versão 16, F4u do cxj, U02): ver `ATRASO_MAXIMO_DA_VAGA_DO_RESGATE_MS`.
      const folgaMs = comIntervalo ? ATRASO_MAXIMO_DA_VAGA_DO_RESGATE_MS : 0;
      lido = { instante, knobs, folgaMs, janelaDaCampanha };
      return {
        limite: tetoDoDia({
          now: instante,
          knobs,
          numberActivatedAt,
          crmDailyLimit: rows[0]?.daily_message_limit ?? null,
          banRisk,
        }),
        desde: dayStartInTz(instante, knobs.timezone),
        // Com a folga da vaga (F4t do cxj, T03): ver `ATRASO_MAXIMO_DA_VAGA_DO_RESGATE_MS`.
        intervaloMs: comIntervalo ? knobs.throttleMs + ATRASO_MAXIMO_DA_VAGA_DO_RESGATE_MS : 0,
        // E a linha leva a hora mais tardia do envio: o instante mais a folga.
        folgaMs,
      };
    },
  );
  if (desfecho !== 'reservada') return { desfecho };
  return { desfecho, ...lido };
}

/** A janela própria de uma campanha (as horas dela e o fuso do número principal), como a rodada a confere. */
interface JanelaDaCampanha {
  ritmo: RitmoDaCampanha;
  fuso: string;
}

/**
 * A janela própria da campanha da mensagem presa (F4u do cxj, U01), lida sob a trava do número, com o que a rodada
 * usa: as horas da campanha (`janela_inicio_hora`, `janela_fim_hora`) e o fuso do número PRINCIPAL dela (o relógio
 * da janela da campanha é um só, ver `rodada.ts`). Só a mensagem de campanha de consentimento chega aqui: a de
 * prospecção não sai pelo resgate (`conferirElegibilidade`). `null` quando a mensagem não é de campanha;
 * `'sem_campanha'` quando a campanha não se acha (nada sai; a conferência seguinte a encerra). Até a versão 15, o
 * resgate conferia só a janela do número, e a mensagem da campanha que encerra às 18h saía às 19h.
 */
async function lerJanelaDaCampanha(
  db: Queryable,
  m: QueuedRow,
  knobs: PacingKnobs,
  log: Logger,
): Promise<JanelaDaCampanha | null | 'sem_campanha'> {
  const campanhaId = campanhaDaMensagem(m.metadata);
  if (campanhaId === null) return null;
  const { rows } = await db.query<{
    janela_inicio_hora: number | null;
    janela_fim_hora: number | null;
    channel_session_id: string | null;
  }>(
    `select k.janela_inicio_hora, k.janela_fim_hora, k.channel_session_id::text as channel_session_id
     from campaigns k where k.organization_id = $1 and k.id::text = $2`,
    [m.organization_id, campanhaId],
  );
  const campanha = rows[0];
  if (!campanha) return 'sem_campanha';
  const principal = campanha.channel_session_id;
  const fuso =
    principal === null || principal === m.channel_session_id
      ? knobs.timezone
      : (await loadChannelKnobs(db, m.organization_id, principal, log)).knobs.timezone;
  return {
    ritmo: {
      intervaloSegundos: null,
      janelaInicioHora: campanha.janela_inicio_hora,
      janelaFimHora: campanha.janela_fim_hora,
      tetoDiario: null,
      tetoHorario: null,
    },
    fuso,
  };
}

/** A janela da campanha aberta no instante: a conta de `podeMandarAgora`, só com as horas, como a rodada faz. */
function janelaDaCampanhaAberta(janela: JanelaDaCampanha, instante: Date): boolean {
  return podeMandarAgora(janela.ritmo, { ultimoEnvio: null, enviadasHoje: 0, enviadasNaUltimaHora: 0 }, instante, janela.fuso)
    .pode;
}

/**
 * O desfecho da reserva da vaga do resgate: reservada, com o instante da linha gravada e os knobs
 * lidos sob a trava; ou o motivo de não reservar.
 */
type VagaDoResgate =
  | {
      desfecho: 'reservada';
      instante: Date;
      knobs: PacingKnobs;
      /** A folga com que a linha foi gravada (o instante mais ela); a devolução a procura com a mesma. */
      folgaMs: number;
      /** A janela própria da campanha da mensagem, ou `null` (não é de campanha): conferida de novo antes do envio. */
      janelaDaCampanha: JanelaDaCampanha | null;
    }
  | { desfecho: Exclude<ReservaDaVaga, 'reservada'> | 'fora_da_janela' | 'fora_da_janela_da_campanha' };

/**
 * Devolve a vaga de uma saída do resgate que certamente não aconteceu: o WAHA recusou com 4xx, ou
 * a conferência de depois da reserva barrou o envio (F4q do cxj, Q03). A linha devolvida é a do
 * tipo reservado (disparo, ou resposta). Se o banco recusar, a vaga fica — o teto conta uma a
 * mais, o lado seguro —, e o log diz.
 */
async function devolverVagaDoResgate(
  pool: pg.Pool,
  m: QueuedRow,
  vaga: { instante: Date; folgaMs: number },
  log: Logger,
): Promise<void> {
  try {
    await undoSend(pool, m.organization_id, m.channel_session_id, vaga.instante, {
      resposta: m.resposta,
      folgaMs: vaga.folgaMs,
    });
  } catch (err) {
    log.error('watchdog: a vaga de um reenvio que não saiu ficou no limite do número', {
      message_id: m.id,
      channel_session_id: m.channel_session_id,
      sent_at: vaga.instante.toISOString(),
      folga_ms: vaga.folgaMs,
      resposta: m.resposta,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }
}

/** O que a conferência da mensagem presa decidiu: ela pode sair; o processo está de saída; ou ela não sai. */
type Elegibilidade = 'pode_sair' | 'desligando' | 'nao_sai';

/**
 * Relê o que decide se a mensagem presa ainda pode sair por este resgate: ela segue `queued`, a
 * sessão do número segue no ar (`WORKING`), o contato não foi bloqueado e nenhum job vivo tem a
 * chave dela (as condições da consulta do resgate; F4r do cxj, R08), a organização opera, o canal
 * não está pausado, o modo de teste deixa o número, o envio original iria ao contato (a cadeia,
 * na mensagem da IA; o contato pessoal, em todas; F4r do cxj, R06), e ela não é de campanha de
 * prospecção. Quando não pode, grava o desfecho na mensagem e diz `nao_sai` (a que deixou a fila,
 * a da sessão fora do ar, a do contato bloqueado e a do job vivo não são tocadas: ficam como a
 * consulta do resgate as deixa). Roda ANTES da reserva da vaga e de novo DEPOIS dela (F4q do cxj,
 * Q03): a reserva espera a conexão e a trava do número, e o que muda nessa espera vale.
 *
 * O que muda com a mensagem na fila é lido numa consulta só, no mesmo instante, e ela é a última
 * leitura antes do envio (F4s do cxj, S09): até a versão 13, a régua do envio original e a
 * campanha eram lidas DEPOIS da sessão e do canal, e o canal pausado durante essas leituras não
 * impedia o envio. A régua do envio original entra na mesma consulta (`regraDoStop`, a mesma da
 * cadeia); a base legal da campanha, que não muda com a mensagem na fila, é lida antes dela. O
 * desligamento é conferido depois da consulta que decide (`desligando`), antes de qualquer
 * gravação. Falha de leitura lança, e quem chama não envia.
 */
async function conferirElegibilidade(
  pool: pg.Pool,
  m: QueuedRow,
  signal: AbortSignal | undefined,
  log: Logger,
): Promise<Elegibilidade> {
  // A base legal da campanha da mensagem (o veto da prospecção, lá embaixo), lida antes da
  // consulta que decide: ela não muda enquanto a mensagem espera. O desligamento durante esta
  // leitura para logo depois da consulta de baixo, antes de qualquer gravação.
  const campanhaId = campanhaDaMensagem(m.metadata);
  let baseLegal: string | null = null;
  if (campanhaId !== null) {
    const { rows: campanha } = await pool.query<{ base_legal: string | null }>(
      `select k.base_legal from campaigns k where k.organization_id = $1 and k.id::text = $2`,
      [m.organization_id, campanhaId],
    );
    baseLegal = campanha[0]?.base_legal ?? null;
  }
  // O resgate para onde o envio original pararia (F4r do cxj, R06). A mensagem da IA para onde
  // a CADEIA para: a conversa passada para a equipe, o "sempre atendimento humano", o contato
  // pessoal e o interno (a régua de `readStopFlags`, a primeira regra dura de `before-send.ts`);
  // na fila, ela sairia quando a conversa voltasse ao automático, já fora de contexto. A de
  // automação e a de sistema param onde o envio pela API para: o contato pessoal não recebe nada,
  // manual ou automático (spec 21, etapa 11; o ramo do encontro humano da régua, que lê só o
  // bloqueio e o pessoal). A passagem para a equipe cala a IA, não a automação.
  const parada = regraDoStop('c', m.sent_via !== 'ai');
  const { rows: acesso } = await pool.query<
    { metadata: unknown; phone_number: string | null; operante: boolean } & LinhaDoStop
  >(
    `select s.metadata, c.phone_number, public.fn_org_operante(m.organization_id) as operante,
            ${parada.colunas}
     from messages m
     join channel_sessions s on s.id = m.channel_session_id and s.organization_id = m.organization_id
     join contacts c on c.id = m.contact_id and c.organization_id = m.organization_id${parada.juncao}
     where m.id = $1 and m.organization_id = $2 and m.status = 'queued'
       and s.status = 'WORKING' and c.is_blocked = false
       and ${SEM_JOB_VIVO}`,
    [m.id, m.organization_id],
  );
  // ABORT DURANTE a espera de elegibilidade (#2823): a releitura terminou e
  // NADA foi enviado ainda, então parar aqui não larga envio no meio — é a
  // mesma "para entre itens", no ponto em que o item ainda é barato de
  // recusar. Sem esta linha o `fetch` rodava com o processo já de saída, e o
  // lote continuaria até o fim.
  if (signal?.aborted) return 'desligando';
  const atual = acesso[0];
  if (!atual) return 'nao_sai';
  // Organização parada não fala: o resgate direto ao WAHA não pode ser a
  // porta dos fundos da suspensão. Mesmo desfecho que a suspensão grava.
  if (atual.operante !== true) {
    await pool.query(
      `update messages set status = 'failed', error_code = 'org_suspensa',
         error_message = 'Envio automático bloqueado: a organização está suspensa.'
       where id = $1 and organization_id = $2 and status = 'queued'`,
      [m.id, m.organization_id],
    );
    log.info('watchdog: reenvio bloqueado — organização não operante', { message_id: m.id });
    return 'nao_sai';
  }
  // Canal PAUSADO pelo operador: a fila de antes da pausa não sai por aqui.
  // `failed` e não `queued`, o mesmo desfecho que o `messages/_handler`
  // grava: deixá-la na fila faria o resgate mandar tudo de uma vez quando o
  // operador retomasse o canal.
  if (canalDesativado(atual.metadata)) {
    await pool.query(
      `update messages set status = 'failed', error_code = 'channel_disabled',
         error_message = 'Este canal está desativado. Reative-o na Central de Conexões para voltar a enviar.'
       where id = $1 and organization_id = $2 and status = 'queued'`,
      [m.id, m.organization_id],
    );
    log.info('watchdog: reenvio bloqueado — canal pausado', { message_id: m.id });
    return 'nao_sai';
  }
  if (preGoLiveAtivo(atual.metadata) && !numeroPodeTestar(atual.phone_number ?? '', lerNumerosDeTeste(atual.metadata))) {
    await pool.query(
      `update messages set status = 'failed', error_code = 'pre_go_live',
         error_message = 'Envio automático bloqueado pelo modo de teste do canal.'
       where id = $1 and organization_id = $2 and status = 'queued'`,
      [m.id, m.organization_id],
    );
    log.info('watchdog: reenvio bloqueado pelo modo de teste', { message_id: m.id });
    return 'nao_sai';
  }
  // A que o envio original não mandaria vira falha com o motivo.
  const veredito = vereditoDoStop(atual);
  if (veredito.stopped && veredito.motivo !== null) {
    await pool.query(
      `update messages set status = 'failed', error_code = $3, error_message = $4
       where id = $1 and organization_id = $2 and status = 'queued'`,
      [m.id, m.organization_id, veredito.motivo, ERRO_DA_PARADA[veredito.motivo]],
    );
    log.info('watchdog: reenvio bloqueado — o envio original não iria a este contato', {
      message_id: m.id,
      sent_via: m.sent_via,
      motivo: veredito.motivo,
    });
    return 'nao_sai';
  }
  // A campanha de PROSPECÇÃO só sai pela rodada (F4i, A1 do cxj). Este
  // resgate manda direto ao WAHA sem conferir a pessoa — se respondeu, foi
  // para atendimento humano, recusou, entrou na lista de exclusão — nem a
  // campanha, que pode ter sido cancelada enquanto o canal estava fora. A
  // rodada tira a sua mensagem da fila física e devolve a pessoa à fila da
  // campanha; o que sobrar aqui (o veto que não gravou, a linha de antes
  // desta versão) vira `failed`. Só a campanha de consentimento segue como
  // antes; campanha que não se acha conta como prospecção.
  if (campanhaId !== null && baseLegal !== 'consent') {
    await pool.query(
      `update messages set status = 'failed', error_code = 'campanha_sem_reenvio',
         error_message = 'Não reenviada: a campanha de prospecção só manda pela rodada, que confere a pessoa de novo.'
       where id = $1 and organization_id = $2 and status = 'queued'`,
      [m.id, m.organization_id],
    );
    log.info('watchdog: reenvio bloqueado — mensagem de campanha de prospecção', { message_id: m.id });
    return 'nao_sai';
  }
  return 'pode_sair';
}

/**
 * Reenvia mensagens AI presas em queued com sessão WORKING.
 *
 * `signal` é o do desligamento (#2823) e é OPCIONAL: sem ele o lote anda inteiro
 * como andava antes. Com ele, o laço PARA ENTRE itens — nunca cancela um envio
 * já iniciado. Um `fetch` em voo termina e grava o recibo (`markRedriveSent`);
 * o que é recusado é abrir o PRÓXIMO item com o processo já de saída, que era o
 * caminho para o lote inteiro segurar o shutdown.
 */
export async function redriveQueued(
  pool: pg.Pool,
  cfg: WatchdogConfig,
  log: Logger,
  signal?: AbortSignal,
  // O relógio da vaga (F4p, P07). Fixo só nos testes.
  agora: () => Date = () => new Date(),
): Promise<number> {
  const { rows } = await pool.query<QueuedRow>(
    `select m.id, m.organization_id, m.conversation_id, m.contact_id, m.body, s.waha_session_name,
            c.wa_identity, c.wa_lid, c.phone_number, v.is_group, v.group_chat_id, m.metadata,
            m.channel_session_id, s.provider, m.sent_via,
            -- A resposta presa (F4q do cxj, Q08): a mensagem do agente nasce com o id da chave do
            -- send_ledger (send-message.ts), e o job da chave diz se ela respondia alguém.
            exists (
              select 1 from send_ledger l
              join job_queue j on j.id = l.job_id and j.organization_id = l.organization_id
              where l.organization_id = m.organization_id and l.id = m.id
                and j.kind = any($3::text[])
            ) as resposta
     from messages m
     join channel_sessions s on s.id = m.channel_session_id and s.organization_id = m.organization_id
     join conversations v on v.id = m.conversation_id and v.organization_id = m.organization_id
     join contacts c on c.id = m.contact_id and c.organization_id = m.organization_id
     where m.sent_via in ('ai', 'automation', 'system') and m.status = 'queued'
       and s.status = 'WORKING'
       and c.is_blocked = false
       -- ─── A mensagem de job VIVO é do job (F4r do cxj, R08) ──────────────
       --
       -- O job que a mandou ainda pendente (o follow-up reagendado, o job que volta à fila
       -- quando o worker morre) ou em execução vai mandá-la de novo pela cadeia, com a mesma
       -- chave e todos os portões. Reenviada também daqui, ela saía duas vezes: os dois liam
       -- 'queued'. O resgate fica com a mensagem sem dono: a do job terminado, e a sem job.
       and ${SEM_JOB_VIVO}
       -- ─── Só as sessões que ESTE resgate consegue alcançar ───────────────
       --
       -- Este worker fala um transporte só, direto, e não resolve adapter: ele
       -- e processo separado, com pg cru, sem o seam. Sem este filtro a
       -- consulta trazia mensagem de QUALQUER canal e postava com
       -- session nula — a coluna e nula fora deste transporte. Na melhor
       -- hipótese o provedor recusa e a mensagem fica presa para sempre com um
       -- warn por tique; na pior, um envio sai pelo número errado.
       --
       -- Deixar de fora NÃO é resolver: é parar de fazer a coisa errada. Quem
       -- conta as que ficaram sem resgate é o bloco logo abaixo — silêncio aqui
       -- é o que fez este defeito durar.
       and s.waha_session_name is not null
       and m.created_at < now() - make_interval(secs => $1 / 1000.0)
     order by m.created_at
     limit $2`,
    [cfg.redriveMinAgeMs, cfg.redriveBatchSize, [...KINDS_DE_RESPOSTA]],
  );

  // As que este resgate NÃO alcança. Não são reenviadas daqui — enviar em dobro
  // é pior que não enviar, e este processo não tem como saber se o outro
  // caminho já mandou. O que elas não podem continuar sendo é INVISÍVEIS.
  const { rows: foraDoAlcance } = await pool.query<{ n: string }>(
    `select count(*)::text as n
     from messages m
     join channel_sessions s on s.id = m.channel_session_id
     where m.sent_via in ('ai', 'automation', 'system') and m.status = 'queued'
       and s.status = 'WORKING'
       and s.waha_session_name is null
       and m.created_at < now() - make_interval(secs => $1 / 1000.0)`,
    [cfg.redriveMinAgeMs],
  );
  const presas = Number(foraDoAlcance[0]?.n ?? '0');
  if (presas > 0) {
    log.warn('watchdog: mensagens presas em canal que este resgate não alcança', {
      quantidade: presas,
    });
  }

  let sent = 0;
  for (const m of rows) {
    // PARA ENTRE itens (#2823): o shutdown não pode herdar o lote inteiro, mas
    // também não se vira contra quem já saiu — quem está em voo termina e grava
    // o recibo; só o próximo item é recusado, e a mensagem recusada continua
    // `queued` para o tique do processo que subir depois.
    if (signal?.aborted) break;
    const chatId = chatIdOf(m, await ultimaRecebidaDaFicha(pool, m, log));
    if (chatId === null || m.body === null) {
      log.warn('watchdog: queued sem destino/corpo — pulada', { message_id: m.id });
      continue;
    }
    // `jaSaiu` separa os dois desfechos que o `catch` de baixo confundia: a
    // mensagem que nunca saiu (reenviar é certo) e a que JÁ chegou ao cliente
    // (reenviar é mandar duas vezes). Declarado FORA do `try` porque é lá que o
    // `catch` o lê — dentro, ele não existiria para o tratamento do erro, e foi
    // exatamente isso que o `pnpm typecheck` pegou na primeira versão deste
    // conserto (TS2304: Cannot find name 'jaSaiu').
    let jaSaiu = false;
    try {
      // A lista pode mudar enquanto a mensagem espera ou entre itens do lote.
      // Este redrive fala direto com o WAHA, portanto também precisa da guarda
      // do sink. Falha de leitura cai no catch e NÃO envia.
      const antes = await conferirElegibilidade(pool, m, signal, log);
      if (antes === 'desligando') break;
      if (antes === 'nao_sai') continue;
      // ─── A VAGA NO LIMITE DO NÚMERO, ANTES DE MANDAR (F4p do cxj, P07) ───
      //
      // Este resgate manda direto ao WAHA, por fora da cadeia do agente, e não contava a saída:
      // com 59 de 60 no dia, a campanha seguinte liberava a 61ª; depois de uma resposta
      // resgatada, passava 1 s depois. Agora ele reserva a vaga como a campanha: o teto do dia e
      // o intervalo do número, conferidos e gravados sob a trava do número. Sem vaga, nada sai, e
      // a mensagem fica `queued` para o próximo tique. A resposta presa (o job que a mandou é um
      // dos `KINDS_DE_RESPOSTA`) reserva como resposta, como a cadeia a contaria: conta no
      // intervalo e não gasta o teto do dia, e não espera o dia seguinte com o teto batido (F4q
      // do cxj, Q08). Sem o job, ela conta como disparo: a mais, o lado seguro. Erro na reserva
      // cai no `catch` de baixo, antes de qualquer envio. O instante da vaga é o do relógio sob a
      // trava (F4s do cxj, S01); a linha leva ele mais a folga (versão 16), e é pelos dois que a
      // devolução acha a linha gravada.
      const vaga = await reservarVagaDoResgate(pool, m, agora, log);
      if (vaga.desfecho !== 'reservada') {
        log.info('watchdog: reenvio adiado — o número está sem vaga agora, ou fora da janela', {
          message_id: m.id,
          motivo: vaga.desfecho,
          resposta: m.resposta,
        });
        continue;
      }
      const quando = vaga.instante;
      // ─── O QUE MUDOU NA ESPERA DA VAGA VALE (F4q do cxj, Q03) ───
      //
      // A reserva espera a conexão e a trava do número; nesse tempo o operador pode pausar o
      // canal, a sessão pode cair, o contato pode ser bloqueado ou passar para a equipe, a
      // organização pode parar, o modo de teste pode voltar, outro caminho pode mandar a
      // mensagem, e o processo pode começar a desligar. A mesma conferência roda de novo, e o que
      // ela barrar devolve a vaga: nada saiu. Falha de leitura também devolve, e não envia. Entre
      // a leitura dela e o `fetch` não há espera nenhuma (F4s do cxj, S09).
      let depois: Elegibilidade;
      try {
        depois = await conferirElegibilidade(pool, m, signal, log);
      } catch (err) {
        await devolverVagaDoResgate(pool, m, vaga, log);
        throw err;
      }
      if (depois !== 'pode_sair') {
        await devolverVagaDoResgate(pool, m, vaga, log);
        log.info('watchdog: reenvio desfeito — a mensagem mudou enquanto esperava a vaga, e a vaga voltou', {
          message_id: m.id,
          motivo: depois,
        });
        if (depois === 'desligando') break;
        continue;
      }
      // ─── A JANELA E A IDADE DA VAGA, NO RELÓGIO DE AGORA (F4s do cxj, S01; F4t, T03) ───
      //
      // A conferência de cima também espera (a conexão, a leitura), e o relógio anda nessa
      // espera: a janela conferida na reserva pode ter fechado. Conferida de novo aqui, com os
      // knobs da reserva; fechada, a vaga volta e a mensagem fica na fila para o tique que a
      // encontrar aberta. E a vaga leva a hora da reserva: com a espera, o envio sairia depois
      // dela, e o seguinte, conferido contra essa hora, a menos do intervalo deste. Mais velha que
      // a folga, a vaga volta e a mensagem espera o tique seguinte; até a folga, a reserva seguinte
      // pede o intervalo mais a folga, e o envio seguinte nunca sai a menos do intervalo deste.
      // Entre esta conta e o `fetch` não há espera nenhuma.
      const agoraDoEnvio = agora();
      if (!janelaDeEnvioAberta(agoraDoEnvio, vaga.knobs, m.resposta)) {
        await devolverVagaDoResgate(pool, m, vaga, log);
        log.info('watchdog: reenvio desfeito — a janela do número fechou antes do envio, e a vaga voltou', {
          message_id: m.id,
          resposta: m.resposta,
        });
        continue;
      }
      // A janela da própria campanha, no mesmo relógio (F4u do cxj, U01): a mensagem de consentimento que esperou a
      // última conferência não sai depois do horário da campanha.
      if (vaga.janelaDaCampanha && !janelaDaCampanhaAberta(vaga.janelaDaCampanha, agoraDoEnvio)) {
        await devolverVagaDoResgate(pool, m, vaga, log);
        log.info('watchdog: reenvio desfeito — a janela da campanha fechou antes do envio, e a vaga voltou', {
          message_id: m.id,
        });
        continue;
      }
      if (agoraDoEnvio.getTime() - quando.getTime() > ATRASO_MAXIMO_DA_VAGA_DO_RESGATE_MS) {
        await devolverVagaDoResgate(pool, m, vaga, log);
        log.info('watchdog: reenvio desfeito — a vaga envelheceu antes do envio, e voltou', {
          message_id: m.id,
          atraso_ms: agoraDoEnvio.getTime() - quando.getTime(),
        });
        continue;
      }
      const res = await fetch(`${cfg.wahaBaseUrl}/api/sendText`, {
        method: 'POST',
        headers: { 'X-Api-Key': cfg.wahaApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: m.waha_session_name, chatId, text: m.body }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        // 4xx: o WAHA recusou o pedido, e nada saiu — a vaga volta. 5xx deixa a saída incerta
        // (o provedor pode ter aceitado antes do erro), e a vaga fica: a mais, nunca a menos.
        // O erro de rede e o tempo esgotado também ficam com ela (caem no `catch`).
        if (res.status >= 400 && res.status < 500) await devolverVagaDoResgate(pool, m, vaga, log);
        log.warn('watchdog: redrive falhou no WAHA — mantida queued para o próximo tick', {
          message_id: m.id,
          status_code: res.status,
        });
        continue;
      }
      jaSaiu = true;
      const data = (await res.json().catch(() => null)) as unknown;
      const externalId = parseWahaMessageId(data);
      // Daqui em diante a mensagem JÁ SAIU para o cliente. Devolvê-la a `queued`
      // é o pior desfecho possível: o `catch` de baixo a trata como falha
      // transiente e o próximo tick a manda de novo — a cada tick, sem limite.
      const idTakenByEcho = await markRedriveSent(pool, m, externalId);
      if (externalId !== null) {
        // O eco desta mensagem pode ter chegado pelo webhook ANTES de a linha
        // acima gravar o id: não casou com nada e virou uma segunda linha com a
        // mesma frase. Mesma limpeza que o envio normal faz
        // (`removerEcoDoProprioEnvio` em `app/api/v1/messages/_handler.ts`), com
        // a mesma lista de ids.
        await removeRedriveEcho(pool, m, externalId, chatId, log);
        if (idTakenByEcho) await stampExternalIdAfterEcho(pool, m, externalId, log);
      }
      sent += 1;
      log.info('watchdog: mensagem presa reenviada', { message_id: m.id, has_external_id: externalId !== null });
    } catch (err) {
      const erro = (err instanceof Error ? err.message : String(err)).slice(0, 120);
      if (jaSaiu) {
        // O comentário acima promete que a mensagem que já saiu não volta para
        // `queued`. A promessa vale para o `23505` (tratado em
        // `markRedriveSent`) e NÃO vale para qualquer outra falha de banco: ali
        // a linha continua `queued` e o próximo tick reenvia ao cliente uma
        // mensagem que ele já recebeu. Não há como consertar daqui — se o banco
        // não aceita escrita, nenhuma marcação passa —, então o mínimo honesto é
        // não chamar isso de transiente e dizer, no nível certo, o que está em
        // risco.
        log.error('watchdog: a mensagem SAIU para o cliente e o banco não registrou — o próximo tick pode reenviar', {
          message_id: m.id,
          error: erro,
        });
      } else {
        log.warn('watchdog: redrive com erro transiente — mantida queued', {
          message_id: m.id,
          error: erro,
        });
      }
    }
    // Espaçamento anti-rajada entre reenvios. ABORTÁVEL (#2823): dormir o
    // intervalo inteiro com o processo já de saída é o shutdown herdando o ritmo
    // do anti-rajada. O ouvinte é REMOVIDO no fim de cada espera, como no laço do
    // drain — sem isso cada item deixa um ouvinte morto no mesmo signal.
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, cfg.redriveSpacingMs + Math.random() * cfg.redriveSpacingMs);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }
  return sent;
}

/** Loop do watchdog — reconcilia e redrive a cada tick; erro nunca derruba o worker. */
export async function runSessionWatchdogLoop(
  pool: pg.Pool,
  cfg: WatchdogConfig,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const fixed = await reconcileSessions(pool, cfg, log);
      // (a) o abort pode ter chegado DURANTE o tick: sem esta linha o redrive
      // abaixo abriria um lote NOVO com o processo já de saída.
      if (signal.aborted) break;
      const redriven = await redriveQueued(pool, cfg, log, signal);
      if (fixed + redriven > 0) {
        log.info('watchdog: tick com ação', { reconciled: fixed, redriven });
      }
    } catch (err) {
      log.error('watchdog: tick falhou', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
    // (a) DEPOIS de cada await e ANTES da espera (#2823): o `addEventListener`
    // de um signal JÁ abortado nunca dispara (o `abort` aconteceu antes), então
    // entrar aqui com o sinal dado faria o laço dormir os 60 s do tick — e o
    // `shutdown` do worker espera este promise ANTES de começar o próprio prazo,
    // herdando o atraso inteiro no `docker stop`.
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      // O ouvinte é REMOVIDO no fim de cada espera, como no laço do drain: sem
      // isso um worker de dias acumula um ouvinte morto por tick no mesmo
      // AbortSignal — vazamento que não aparece como erro, só como memória.
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, cfg.intervalMs);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}
