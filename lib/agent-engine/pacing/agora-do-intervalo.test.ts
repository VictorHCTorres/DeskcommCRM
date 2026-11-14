/**
 * A ESPERA DO INTERVALO CONTA DO RELÓGIO LIDO SOB A TRAVA (F4v do cxj, 12/11/2026, V02; versão 17).
 *
 * `now` é lido pelo chamador antes da fila da trava do número. Contada dele, a espera cobrava de novo o tempo que o
 * envio já tinha passado na fila: cinco respostas concorrentes esperaram 197,2 s, contra 16 s. `agoraDoIntervalo` é
 * o relógio lido sob a trava, junto com o estado. Só a espera muda: a janela e o teto seguem em `now`.
 */
import { describe, expect, it } from 'vitest';

import { PACING_DEFAULTS, type PacingKnobs } from './defaults';
import { decidePacing } from './engine';

const AS_10H = new Date('2026-11-18T10:00:00-03:00');
const knobs = (over: Partial<PacingKnobs> = {}): PacingKnobs => ({
  ...PACING_DEFAULTS,
  throttleMs: 5000,
  jitterMaxMs: 0,
  ...over,
});
/** A última saída do número foi 1 s depois do `now`: a de outro envio que passou na frente, na fila da trava. */
const estado = { lastSentAt: new Date(+AS_10H + 1000), sentToday: 0, numberActivatedAt: null };

describe('decidePacing × agoraDoIntervalo (V02)', () => {
  it.each([true, false])('a espera conta de `agoraDoIntervalo`, e não de `now` (resposta=%s)', (resposta) => {
    const decisao = decidePacing({
      now: AS_10H,
      agoraDoIntervalo: new Date(+AS_10H + 3000),
      knobs: knobs(),
      state: estado,
      crmDailyLimit: null,
      resposta,
      rng: () => 0,
    });
    // A última saída foi a 1 s, o relógio marca 3 s, e o intervalo é de 5 s: faltam 3 s, e não os 6 s contados do `now`.
    expect(decisao).toEqual({ allow: true, waitMs: 3000 });
  });

  it('controle: sem `agoraDoIntervalo`, a espera conta de `now`, como sempre', () => {
    const decisao = decidePacing({ now: AS_10H, knobs: knobs(), state: estado, crmDailyLimit: null, resposta: true, rng: () => 0 });
    expect(decisao).toEqual({ allow: true, waitMs: 6000 });
  });

  it('só a espera muda: a janela segue em `now`', () => {
    // `now` às 23h (fora da janela de disparo, 7h–22h); o relógio sob a trava, dentro dela, não a reabre.
    const as23h = new Date('2026-11-18T23:00:00-03:00');
    const decisao = decidePacing({
      now: as23h,
      agoraDoIntervalo: AS_10H,
      knobs: knobs(),
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
      rng: () => 0,
    });
    expect(decisao.allow).toBe(false);
  });
});
