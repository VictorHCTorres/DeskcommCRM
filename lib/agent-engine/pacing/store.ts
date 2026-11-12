/**
 * Estado durável do pacing (F2-11) — Postgres do harness, sobrevive a restart:
 * knobs por número/sessão (`channel_knobs`, 0010; coluna NULL = default de
 * defaults.ts) e ledger de envios (`pacing_ledger`) de onde saem lastSentAt e
 * sentToday (contado desde a meia-noite LOCAL do tenant). Quem grava no ledger
 * é a cadeia de envio (F2-13) via `recordSend`, e a campanha via `reservarVaga`
 * (a conferência e a gravação da vaga, juntas, sob a trava do número) — este
 * módulo é o seam.
 */
import type pg from 'pg';

import { fusoValido } from '@/lib/tempo/fusos';

import type { Logger } from '../obs/logger';
import type { Queryable } from '../queue/queue';
import { PACING_DEFAULTS, type PacingKnobs, type WarmupStep } from './defaults';
import { dayStartInTz, type PacingState } from './engine';

interface ChannelKnobsRow {
  throttle_ms: number | null;
  jitter_max_ms: number | null;
  window_start_hour: number | null;
  window_end_hour: number | null;
  /** Janela da RESPOSTA do agente (0495). NULL = usa `window_*` (comportamento anterior). */
  resposta_start_hour: number | null;
  resposta_end_hour: number | null;
  /** Números do atraso humano antes da 1ª bolha (0499). NULL = default (defaults.ts). */
  atraso_notar_ms: number | null;
  ms_por_caractere: number | null;
  atraso_minimo_ms: number | null;
  atraso_maximo_ms: number | null;
  allow_sunday: boolean | null;
  /** Dias da prospecção (0642, `smallint[]`, 0=dom … 6=sáb). Coluna NOT NULL. */
  prospeccao_dias: number[] | null;
  timezone: string | null;
  warmup_daily_caps: unknown; // jsonb — shape validado em parseWarmupCaps (nunca confiado)
  /** Nulo quando o número não tem linha em channel_knobs (o `left join` da leitura). */
  number_activated_at: Date | null;
  /** `organizations.timezone` — o fuso da janela de quem não escolheu um no número. */
  org_timezone?: string | null;
}

/**
 * O fuso em que a janela de envio é avaliada: o do NÚMERO, se alguém o escolheu
 * em Conexões › Proteção de envio; senão o da ORGANIZAÇÃO; senão o padrão.
 *
 * O degrau do meio faltava. Sem linha em `channel_knobs` — o caso de quem nunca
 * abriu aquela tela — a janela caía direto no literal de `PACING_DEFAULTS`,
 * `America/Sao_Paulo`, qualquer que fosse o fuso da empresa. Numa organização
 * em `Europe/Lisbon` a janela 7h–22h virava 11h–02h de Lisboa, e a resposta do
 * agente a quem escreveu às 9h esperava até as 11h. É o mesmo defeito que
 * `agent/fuso-da-org.ts` descreve para o relógio do turno, do lado da janela.
 *
 * O fuso da organização não é validado por escritor nenhum (ver o cabeçalho de
 * `fuso-da-org.ts`), e o `Intl` LANÇA num fuso inválido: por isso ele passa por
 * `fusoValido` e degrada para o padrão, em vez de derrubar o envio.
 */
export function fusoDaJanela(
  doCanal: string | null | undefined,
  daOrganizacao: string | null | undefined,
): string {
  if (doCanal) return doCanal;
  const tz = daOrganizacao?.trim() ?? '';
  return tz !== '' && fusoValido(tz) ? tz : PACING_DEFAULTS.timezone;
}

/**
 * Valida o shape do jsonb de degraus (defesa em profundidade com o CHECK da 0010:
 * cobre linha legada/escritor externo e shape errado dentro de um array válido).
 * Inválido → null: o load cai nos DEFAULTS conservadores — falha fechado sem
 * exceção no caminho de envio. Array VAZIO conta como inválido: zero degraus =
 * warm-up desligado, um fail-open silencioso; opt-out legítimo tem forma expressa
 * `[{"minAgeDays":0,"cap":null}]` (1 degrau formado), nunca `[]`.
 */
export function parseWarmupCaps(value: unknown): WarmupStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps: WarmupStep[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { minAgeDays, cap } = item as Record<string, unknown>;
    if (typeof minAgeDays !== 'number' || !Number.isFinite(minAgeDays)) return null;
    if (cap !== null && (typeof cap !== 'number' || !Number.isFinite(cap))) return null;
    steps.push({ minAgeDays, cap });
  }
  return steps.length > 0 ? steps : null;
}

/**
 * Dias da prospecção vindos do banco (0642, `smallint[]`, 0=dom … 6=sáb).
 * Fora do 0..6, duplicado ou vazio → null: o load cai na regra antiga
 * (`allowSunday`), com warn — a mesma falha fechada do warm-up (nunca exceção
 * no caminho de envio, nunca fila parada em silêncio por dado corrupto).
 */
export function parseDiasDaProspeccao(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const dias = [
    ...new Set(
      value.filter(
        (d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6,
      ),
    ),
  ].sort((a, b) => a - b);
  return dias.length > 0 ? dias : null;
}

export interface ChannelPacingConfig {
  knobs: PacingKnobs;
  /** null = sem linha em channel_knobs → o engine trata como idade 0 (conservador). */
  numberActivatedAt: Date | null;
}

/**
 * Knobs efetivos do número: linha de channel_knobs (se houver) sobre os defaults.
 * `logger` (o estruturado de obs/) registra knob inválido descartado — a cadeia
 * de envio (F2-13) passa o logger do daemon.
 */
export async function loadChannelKnobs(
  db: Queryable,
  tenantId: string,
  channelSessionId: string,
  logger?: Logger,
): Promise<ChannelPacingConfig> {
  // Parte da ORGANIZAÇÃO, e não do número: sem linha em channel_knobs a janela
  // ainda precisa do fuso da empresa (`fusoDaJanela`). Uma ida ao banco só.
  const { rows } = await db.query<ChannelKnobsRow>(
    `select k.throttle_ms, k.jitter_max_ms, k.window_start_hour, k.window_end_hour,
            k.resposta_start_hour, k.resposta_end_hour,
            k.atraso_notar_ms, k.ms_por_caractere, k.atraso_minimo_ms, k.atraso_maximo_ms,
            k.allow_sunday, k.prospeccao_dias, k.timezone, k.warmup_daily_caps, k.number_activated_at,
            o.timezone as org_timezone
     from organizations o
     left join channel_knobs k
       on k.organization_id = o.id and k.channel_session_id = $2
     where o.id = $1`,
    [tenantId, channelSessionId],
  );
  const row = rows[0];
  if (!row) {
    return { knobs: { ...PACING_DEFAULTS }, numberActivatedAt: null };
  }
  let warmupDailyCaps = PACING_DEFAULTS.warmupDailyCaps;
  if (row.warmup_daily_caps !== null) {
    const parsed = parseWarmupCaps(row.warmup_daily_caps);
    if (parsed) {
      warmupDailyCaps = parsed;
    } else {
      // Falha FECHADO sem derrubar o worker: knob inválido é descartado em favor
      // dos defaults conservadores; o alerta é log (ids não são PII).
      logger?.warn('warmup_daily_caps inválido em channel_knobs — usando defaults conservadores', {
        tenantId,
        channelSessionId,
      });
    }
  }
  return {
    knobs: {
      throttleMs: row.throttle_ms ?? PACING_DEFAULTS.throttleMs,
      jitterMaxMs: row.jitter_max_ms ?? PACING_DEFAULTS.jitterMaxMs,
      atrasoNotarMs: row.atraso_notar_ms ?? PACING_DEFAULTS.atrasoNotarMs,
      msPorCaractere: row.ms_por_caractere ?? PACING_DEFAULTS.msPorCaractere,
      atrasoMinimoMs: row.atraso_minimo_ms ?? PACING_DEFAULTS.atrasoMinimoMs,
      atrasoMaximoMs: row.atraso_maximo_ms ?? PACING_DEFAULTS.atrasoMaximoMs,
      windowStartHour: row.window_start_hour ?? PACING_DEFAULTS.windowStartHour,
      windowEndHour: row.window_end_hour ?? PACING_DEFAULTS.windowEndHour,
      // `null` nestas duas = o número nunca foi configurado com janela de
      // resposta própria, e aí vale a janela de DISPARO. Sem esse `??`, um clone
      // que rodou a 0495 porém nunca gravou as colunas teria resposta bloqueada
      // fora de 7h-22h (o default do arquivo), que é justamente o que ele já
      // fazia — mas por outro caminho, e ninguém saberia dizer qual.
      respostaStartHour: row.resposta_start_hour ?? row.window_start_hour ?? PACING_DEFAULTS.respostaStartHour,
      respostaEndHour: row.resposta_end_hour ?? row.window_end_hour ?? PACING_DEFAULTS.respostaEndHour,
      allowSunday: row.allow_sunday ?? PACING_DEFAULTS.allowSunday,
      // Dias próprios da prospecção (0642). Inválido/vazio cai na regra antiga
      // (`allowSunday`), com warn — nunca fila parada em silêncio.
      prospeccaoDias: (() => {
        const dias = parseDiasDaProspeccao(row.prospeccao_dias);
        if (dias) return dias;
        if (row.prospeccao_dias !== null && row.prospeccao_dias !== undefined) {
          logger?.warn('prospeccao_dias inválido em channel_knobs — usando a regra antiga', {
            tenantId,
            channelSessionId,
          });
        }
        const domingo = row.allow_sunday ?? PACING_DEFAULTS.allowSunday;
        return domingo ? [...PACING_DEFAULTS.prospeccaoDias] : [1, 2, 3, 4, 5, 6];
      })(),
      timezone: fusoDaJanela(row.timezone, row.org_timezone),
      warmupDailyCaps,
    },
    numberActivatedAt: row.number_activated_at,
  };
}

/** lastSentAt (qualquer dia) + sentToday (desde a meia-noite local do tenant). */
export async function loadPacingState(
  db: Queryable,
  tenantId: string,
  channelSessionId: string,
  input: { now: Date; timezone: string; numberActivatedAt: Date | null },
): Promise<PacingState> {
  const dayStart = dayStartInTz(input.now, input.timezone);
  // Dois subselects e não `max` + `count(*) filter`: com o filtro de data fora do
  // WHERE, a agregação lia o histórico inteiro do número a cada envio, sob o lock.
  // Assim os dois descem por `idx_pacing_ledger_session (org, sessão, sent_at desc)`:
  // a última linha e só as linhas do dia. Mesmo molde de `ledger-supabase.ts`.
  const { rows } = await db.query<{ last_sent_at: Date | null; sent_today: string }>(
    `select (select sent_at from pacing_ledger
              where organization_id = $1 and channel_session_id = $2
              order by sent_at desc limit 1) as last_sent_at,
            (select count(*) from pacing_ledger
              where organization_id = $1 and channel_session_id = $2
                and sent_at >= $3 and not resposta) as sent_today`,
    [tenantId, channelSessionId, dayStart],
  );
  const row = rows[0];
  return {
    lastSentAt: row?.last_sent_at ?? null,
    sentToday: Number(row?.sent_today ?? 0),
    numberActivatedAt: input.numberActivatedAt,
  };
}

/**
 * A última linha do número, a mesma de `loadPacingState` (`lastSentAt`); `null` sem linha nenhuma.
 *
 * A cadeia de envio a relê durante a espera do intervalo, sob a trava do número (versão 17, F4v do cxj, V02): a linha
 * de uma saída ainda em curso está na hora mais tardia dela, e recua quando o transporte volta, ou some, se nada saiu.
 */
export async function lerUltimaSaida(
  db: Queryable,
  tenantId: string,
  channelSessionId: string,
): Promise<Date | null> {
  const { rows } = await db.query<{ sent_at: Date }>(
    `select sent_at from pacing_ledger
      where organization_id = $1 and channel_session_id = $2
      order by sent_at desc limit 1`,
    [tenantId, channelSessionId],
  );
  return rows[0]?.sent_at ?? null;
}

/**
 * Registra uma saída do número no limite diário e devolve o id da linha.
 *
 * A cadeia de envio (`runBeforeSend`) grava ANTES do transporte e confirma a linha antes de
 * chamá-lo (F4p do cxj): se nada sair, ela apaga esta linha pelo id. `null` só quando o banco
 * não devolve a linha (dublê de teste).
 *
 * `resposta: true` marca a linha como resposta a quem escreveu: ela segue valendo
 * para o espaçamento (`lastSentAt`), mas não gasta o teto do dia (`sentToday`),
 * que mede só quantas pessoas o número aborda. Omitir = disparo (conta).
 */
export async function recordSend(
  db: Queryable,
  tenantId: string,
  channelSessionId: string,
  sentAt: Date = new Date(),
  opts: { resposta?: boolean } = {},
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `insert into pacing_ledger (organization_id, channel_session_id, sent_at, resposta)
     values ($1, $2, $3, $4)
     returning id`,
    [tenantId, channelSessionId, sentAt, opts.resposta === true],
  );
  return rows?.[0]?.id ?? null;
}

/** A regra que a vaga de um disparo tem de cumprir na hora de ser gravada (`reservarVaga`). */
export interface RegraDaVaga {
  /** O teto de DISPAROS do dia do número (`tetoDoDia`, engine.ts); `null` = sem teto. */
  limite: number | null;
  /** O início do dia do número (`dayStartInTz`): a contagem do teto parte daqui. */
  desde: Date;
  /** Quantas vagas têm de caber: todos os balões da mensagem, no 1º; uma, nos seguintes. */
  vagas: number;
  /** O intervalo mínimo desde o último envio do número (o throttle, sem o jitter); 0 = não confere. */
  intervaloMs: number;
  /**
   * Quanto a saída de verdade pode vir depois do instante da vaga (F4u do cxj, U02): a linha é gravada no instante MAIS
   * esta folga, a hora mais tardia em que a mensagem pode sair. Quem grava a folga tem de garanti-la: a campanha e o
   * resgate não mandam a vaga mais velha que ela (`ATRASO_MAXIMO_DA_VAGA_DA_CAMPANHA_MS`,
   * `ATRASO_MAXIMO_DA_VAGA_DO_RESGATE_MS`), e a devolvem. Todo emissor do número mede o intervalo a partir da última
   * linha: gravada no instante da reserva, a resposta da IA contava o intervalo de uma hora em que a mensagem ainda não
   * tinha saído, e saía a 3,1 s dela com o intervalo em 5 s. A devolução procura a linha com a mesma folga (`undoSend`).
   * Omitida, ou não positiva, a linha fica no instante.
   */
  folgaMs?: number;
  /** Quanto esperar pela trava do número antes de desistir; o padrão é `ESPERA_PELA_TRAVA_MS`. */
  esperaMs?: number;
  /**
   * A vaga é de uma RESPOSTA a quem escreveu (a resposta presa que o resgate da fila manda, F4q do
   * cxj, Q08): a linha é gravada com `resposta = true`, conta no intervalo e não gasta o teto do
   * dia, e o `limite` não é conferido — a mesma conta de `loadPacingState`. Omitir = disparo.
   */
  resposta?: boolean;
}

/** O que a reserva fez: gravou a vaga, ou não havia vaga (o teto do dia, ou o intervalo do número). */
export type ReservaDaVaga = 'reservada' | 'teto_cheio' | 'intervalo';

/**
 * Até quanto a reserva espera a trava do número. A cadeia do agente a segura durante a
 * decisão (as leituras, os gates, a espera do throttle e o registro da saída), e não mais
 * durante o transporte (F4p do cxj); passado isto, a reserva lança, e o balão não sai.
 */
export const ESPERA_PELA_TRAVA_MS = 15_000;

/**
 * Reserva a vaga de um DISPARO do número (ou, com `regra.resposta`, de uma resposta, que
 * não confere o teto): confere o teto do dia e o intervalo e grava a linha no ledger numa
 * transação só, sob o `pg_advisory_xact_lock(hashtext(número))`
 * da cadeia do agente (`before-send.ts`, INBOX-008). Quem chega depois espera a vez e
 * relê o ledger já com a vaga de quem passou.
 *
 * É a vaga da campanha (revisão F4n do cxj, N12): a rodada lia o saldo do número
 * (`loadPacingState`) e gravava a vaga (`recordSend`) em dois passos, e duas rodadas
 * sobrepostas liam o mesmo 59 de 60 e mandavam as duas. A leitura da rodada continua
 * escolhendo o número; esta, sob a trava, é a que decide. As contas são as de
 * `loadPacingState`: a resposta não gasta o teto, mas conta no intervalo.
 *
 * Sem vaga, não grava nada e devolve o motivo. O erro do banco (inclusive a trava que
 * não veio no prazo) lança sem gravar nada; a conexão do erro é descartada e nunca
 * volta ao pool no meio de uma transação (#2506).
 *
 * `sentAt` pode ser o relógio (F4t do cxj, T02): o instante é lido SOB a trava, como na
 * `reservarVagaRelida`, e é ele que o intervalo e o registro usam. A rodada da campanha manda o
 * relógio: com o instante de antes da espera, a vaga ficava gravada antes da saída de verdade.
 */
export async function reservarVaga(
  pool: Pick<pg.Pool, 'connect'>,
  tenantId: string,
  channelSessionId: string,
  sentAt: Date | (() => Date),
  regra: RegraDaVaga,
): Promise<ReservaDaVaga> {
  return reservarSobATrava<never>(pool, tenantId, channelSessionId, sentAt, regra, async () => regra);
}

/** A parte da regra da vaga que `reservarVagaRelida` lê sob a trava do número. */
export type RegraRelida = Pick<RegraDaVaga, 'limite' | 'desde' | 'intervaloMs' | 'folgaMs'>;

/**
 * `reservarVaga` com a regra lida SOB a trava do número, dentro da transação da reserva (F4r do
 * cxj, R05 e R07). `reler` recebe a conexão da reserva e devolve o teto, o início do dia e o
 * intervalo que valem agora, ou um motivo para não reservar (o resgate da fila devolve a janela
 * fechada), que volta como o desfecho, sem gravar nada. O que o operador mudou enquanto a reserva
 * esperava a trava (o limite diário do CRM, o aquecimento, o intervalo, a janela) vale; lida
 * antes, a regra conferia a vaga com o que já tinha mudado. A falha de `reler` lança, como a de
 * qualquer leitura da reserva, e nada é gravado.
 *
 * `sentAt` pode ser o relógio, e não o instante (F4s do cxj, S01): então o instante da vaga é lido
 * SOB a trava, e é ele que `reler` recebe e que o intervalo e o registro usam. Medido antes, o
 * instante não contava a espera pela conexão e pela trava: a janela conferia uma hora que já tinha
 * passado, e a vaga ficava gravada antes da saída de verdade, o que encurtava o intervalo do envio
 * seguinte.
 */
export async function reservarVagaRelida<Motivo extends string>(
  pool: Pick<pg.Pool, 'connect'>,
  tenantId: string,
  channelSessionId: string,
  sentAt: Date | (() => Date),
  base: Pick<RegraDaVaga, 'vagas' | 'resposta' | 'esperaMs'>,
  reler: (db: Queryable, instante: Date) => Promise<RegraRelida | Motivo>,
): Promise<ReservaDaVaga | Motivo> {
  return reservarSobATrava(pool, tenantId, channelSessionId, sentAt, base, reler);
}

async function reservarSobATrava<Motivo extends string>(
  pool: Pick<pg.Pool, 'connect'>,
  tenantId: string,
  channelSessionId: string,
  sentAt: Date | (() => Date),
  base: Pick<RegraDaVaga, 'vagas' | 'resposta' | 'esperaMs'>,
  reler: (db: Queryable, instante: Date) => Promise<RegraRelida | Motivo>,
): Promise<ReservaDaVaga | Motivo> {
  const client = await pool.connect();
  let erro: Error | undefined;
  try {
    await client.query('begin');
    await client.query("select set_config('lock_timeout', $1, true)", [
      `${base.esperaMs ?? ESPERA_PELA_TRAVA_MS}ms`,
    ]);
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [channelSessionId]);
    // Com o relógio, o instante é o de agora, já com a trava na mão (F4s do cxj, S01).
    const instante = typeof sentAt === 'function' ? sentAt() : sentAt;
    const regra = await reler(client, instante);
    if (typeof regra === 'string') {
      await client.query('rollback');
      return regra;
    }
    const { rows } = await client.query<{ ultimo: Date | null; do_dia: string }>(
      `select (select sent_at from pacing_ledger
                where organization_id = $1 and channel_session_id = $2
                order by sent_at desc limit 1) as ultimo,
              (select count(*) from pacing_ledger
                where organization_id = $1 and channel_session_id = $2
                  and sent_at >= $3 and not resposta) as do_dia`,
      [tenantId, channelSessionId, regra.desde],
    );
    const doDia = Number(rows[0]?.do_dia ?? 0);
    const ultimo = rows[0]?.ultimo ?? null;
    const resposta = base.resposta === true;
    const semVaga: ReservaDaVaga | null =
      !resposta && regra.limite !== null && doDia + base.vagas > regra.limite
        ? 'teto_cheio'
        : regra.intervaloMs > 0 &&
            ultimo !== null &&
            instante.getTime() - new Date(ultimo).getTime() < regra.intervaloMs
          ? 'intervalo'
          : null;
    if (semVaga) {
      await client.query('rollback');
      return semVaga;
    }
    // O intervalo confere o instante; a linha leva a hora mais tardia da saída (F4u do cxj, U02).
    await client.query(
      `insert into pacing_ledger (organization_id, channel_session_id, sent_at, resposta)
       values ($1, $2, $3, $4)`,
      [tenantId, channelSessionId, comFolga(instante, regra.folgaMs), resposta],
    );
    await client.query('commit');
    return 'reservada';
  } catch (err) {
    erro = err instanceof Error ? err : new Error(String(err));
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release(erro);
  }
}

/**
 * Devolve a vaga de um disparo que NÃO saiu: tira UMA linha de disparo (nunca a
 * de resposta) daquele número, naquele instante. Sem linha, não tira nada. Com
 * `resposta: true`, tira a linha de RESPOSTA daquele instante (nunca a de disparo):
 * a vaga que o resgate da fila reservou para uma resposta presa que o canal recusou
 * (F4q do cxj, Q08).
 *
 * A campanha registra a vaga ANTES de o balão sair (`rodada.ts`), para nenhuma
 * mensagem sair fora do teto do número (revisão F4m do cxj, M01), e a devolve
 * quando o balão certamente não saiu: o handler vetou, a organização parou, ou o
 * canal segurou a mensagem sem chamar o provedor.
 *
 * `sentAt` é o instante da reserva, e `opts.folgaMs` a folga com que ela foi gravada
 * (`RegraDaVaga.folgaMs`): a linha está no instante mais a folga.
 */
export async function undoSend(
  db: Queryable,
  tenantId: string,
  channelSessionId: string,
  sentAt: Date,
  opts: { resposta?: boolean; folgaMs?: number } = {},
): Promise<void> {
  await db.query(
    `delete from pacing_ledger
      where id = (select id from pacing_ledger
                   where organization_id = $1 and channel_session_id = $2
                     and sent_at = $3 and resposta = $4
                   limit 1)`,
    [tenantId, channelSessionId, comFolga(sentAt, opts.folgaMs), opts.resposta === true],
  );
}

/** A hora gravada na linha da vaga: o instante mais a folga (`RegraDaVaga.folgaMs`); sem folga positiva, o instante. */
function comFolga(instante: Date, folgaMs: number | undefined): Date {
  return folgaMs !== undefined && folgaMs > 0 ? new Date(instante.getTime() + folgaMs) : instante;
}
