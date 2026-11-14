// @vitest-environment node
/**
 * F4q do cxj (Q08) · o resgate da fila (`redriveQueued`) manda a mensagem presa como RESPOSTA
 * quando o job que a mandou é um dos `KINDS_DE_RESPOSTA`: a vaga dela não gasta o teto do dia e
 * conta no intervalo, como a cadeia do agente faz com a resposta. A cadeia classifica a saída
 * pelo mesmo job: o turno de resposta (`eTurnoDeResposta`, que o turno passa como `resposta`) e a
 * resposta aprovada (`approved-reply.ts`, `resposta: true` fixo). Os demais mandam como disparo
 * (o follow-up, a entrega da reunião, o aviso de escalação de dentro do follow-up).
 *
 * Se as duas classificações se afastarem, uma resposta presa volta a esperar o teto do dia, ou um
 * disparo preso sai sem gastá-lo. Este teste as prende, kind a kind; um kind novo em `JobKind`
 * que falte aqui quebra o typecheck.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { eTurnoDeResposta } from '@/lib/agent-engine/agent/inbound-turn';
import { KINDS_DE_RESPOSTA, type JobKind } from '@/lib/agent-engine/queue/queue';

const TODOS = [
  'inbound_turn',
  'followup_turn',
  'watchdog',
  'flywheel',
  'case_reply_turn',
  'operator_turn',
  'transactional_delivery',
  'approved_reply',
] as const satisfies readonly JobKind[];

type Faltando = Exclude<JobKind, (typeof TODOS)[number]>;
const todosOsKinds: [Faltando] extends [never] ? true : Faltando = true;

/** A resposta aprovada passa `resposta: true` à cadeia (o arquivo é lido, não suposto). */
function respostaAprovadaVaiComoResposta(): boolean {
  const fonte = readFileSync(join(process.cwd(), 'lib/agent-engine/agent/approved-reply.ts'), 'utf8');
  return /runBeforeSend\(\{[\s\S]*?\n\s*resposta: true,[\s\S]*?\}\);/.test(fonte);
}

describe('F4q do cxj (Q08) · o resgate classifica a resposta presa como a cadeia', () => {
  it('a lista cobre todos os kinds do job', () => {
    expect(todosOsKinds).toBe(true);
    expect(new Set(KINDS_DE_RESPOSTA).size).toBe(KINDS_DE_RESPOSTA.length);
  });

  it.each(TODOS)('%s: resposta no resgate se, e só se, resposta na cadeia', (kind) => {
    const naCadeia = eTurnoDeResposta({ kind }) || (kind === 'approved_reply' && respostaAprovadaVaiComoResposta());

    expect(KINDS_DE_RESPOSTA.includes(kind)).toBe(naCadeia);
  });
});
