/**
 * A RESPOSTA RETIDA NÃO É ULTRAPASSADA (versão 18, F4w do cxj, 12/11/2026, W02).
 *
 * A resposta do agente mais velha do que a folga no último passo do handler fica na fila (`queued`, com o motivo
 * `saida_do_agente_vencida`), e quem a manda depois é o resgate do watchdog, quando o job dela termina, ou a nova
 * tentativa do job, se ele falhar por outra razão (`lib/agent-engine/pacing/saida-do-agente.ts`). O turno segue: a
 * resposta seguinte, com outro registro, saía na hora, e a retida chegava depois dela, fora de ordem.
 *
 * A regra: nenhum texto do agente sai enquanto houver, na mesma conversa, uma resposta do agente retida e mais antiga.
 *
 * - No handler (`app/api/v1/messages/_handler.ts`), a mensagem de texto do agente que acha uma retida mais antiga não
 *   sai: fica na fila, com o motivo `atras_de_resposta_retida`. Se ela também responde a quem escreveu, leva a marca
 *   de resposta, e segura as seguintes.
 * - No resgate (`lib/agent-engine/edge/crm/session-reconciler.ts`), a mensagem presa que tem uma retida mais antiga na
 *   conversa não é selecionada, e a releitura de antes do envio confere de novo: sai uma por conversa a cada tique, da
 *   mais antiga para a mais nova.
 *
 * RETIDA é a mensagem de saída, de texto, ainda na fila, com um dos dois motivos da cadeia do agente, com a marca de
 * resposta (`MARCA_DE_RESPOSTA_RETIDA`, em `metadata`), criada há menos do que a validade. MAIS ANTIGA é pela hora de
 * criação e, na mesma hora, pelo id.
 *
 * Por que só a resposta segura: o envio do agente que não responde a ninguém (o retorno prometido, o follow-up) conta
 * no teto do dia e na janela do número, e o resgate pode levar horas para mandá-lo; a resposta não espera por ele. Por
 * que só o texto: o resgate só manda texto, e a mídia retida ficaria na frente para sempre.
 *
 * A VALIDADE preserva o atendimento. A retida sai, em regra, no tique seguinte ao fim do job dela (até 60 s). Se ela
 * não sair (o provedor a recusa, o job dela não termina), a conversa não fica muda: passada a validade, ela deixa de
 * segurar as seguintes. Dentro da validade vale a ordem; depois dela, vale responder.
 */
import type { Queryable } from '../queue/queue';
import { MARCA_DE_RESPOSTA_RETIDA, MOTIVOS_DA_SAIDA_RETIDA } from './saida-do-agente';

/** Por quanto tempo, a contar da criação, a resposta retida segura as mensagens seguintes da conversa. */
export const VALIDADE_DA_RESPOSTA_RETIDA_MS = 10 * 60_000;

/**
 * A condição SQL “há uma resposta do agente retida e mais antiga do que a mensagem `m`, na conversa dela”, para a
 * consulta em que a mensagem tem o apelido `m` (o handler pergunta por ela em `haRespostaRetidaAntes`; o resgate a põe
 * na seleção e na releitura). Só constantes do código entram no texto.
 */
export function respostaRetidaAntesSql(m: string): string {
  const motivos = MOTIVOS_DA_SAIDA_RETIDA.map((motivo) => `'${motivo}'`).join(', ');
  return `exists (
       select 1 from messages retida
        where retida.organization_id = ${m}.organization_id
          and retida.conversation_id = ${m}.conversation_id
          and retida.direction = 'outbound' and retida.type = 'text' and retida.status = 'queued'
          and retida.metadata->>'queued_reason' in (${motivos})
          and retida.metadata->>'${MARCA_DE_RESPOSTA_RETIDA}' = 'true'
          and retida.created_at > now() - make_interval(secs => ${VALIDADE_DA_RESPOSTA_RETIDA_MS / 1000})
          and (retida.created_at, retida.id) < (${m}.created_at, ${m}.id)
     )`;
}

/**
 * Há, nesta conversa, uma resposta do agente retida e mais antiga do que esta mensagem? A mensagem é a do envio, já
 * gravada pelo handler. Se ela não é achada, lança: sem a linha não há ordem a conferir, e a mensagem não sai.
 */
export async function haRespostaRetidaAntes(
  db: Queryable,
  organizationId: string,
  mensagem: { conversationId: string; messageId: string },
): Promise<boolean> {
  const { rows } = await db.query<{ retida: boolean }>(
    `select ${respostaRetidaAntesSql('m')} as retida
       from messages m
      where m.organization_id = $1 and m.conversation_id = $2 and m.id = $3`,
    [organizationId, mensagem.conversationId, mensagem.messageId],
  );
  const linha = rows[0];
  if (!linha) throw new Error('mensagem_do_envio_nao_encontrada');
  return linha.retida === true;
}
