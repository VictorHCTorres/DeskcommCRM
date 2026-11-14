/**
 * Número com a data de ativação no futuro (erro de digitação do admin, relógio do
 * daemon adiantado em relação ao banco) conta como idade 0 — o aquecimento falha
 * FECHADO, nunca vira "número formado" por idade negativa (`tetosDoDia`, engine.ts).
 *
 * Os degraus vêm na ordem em que o admin os gravou: `parseWarmupCaps` (store.ts) não
 * os ordena, e `warmupCapFor` começa pelo cap do PRIMEIRO da lista. Com os degraus em
 * ordem crescente a idade negativa e a idade 0 dão o mesmo cap; fora de ordem, não —
 * sem o clamp, a idade negativa fica com o cap do primeiro da lista (aqui, "sem
 * limite") em vez do degrau do dia 0. É por isso que estes casos usam degraus fora de
 * ordem: são a configuração em que a falta do clamp abre o número.
 *
 * Achado do arnês de mutações da v9 (mutação "N12 tetosDoDia sem o clamp da idade",
 * sobrevivente em 12/11/2026).
 */
import { describe, expect, it } from 'vitest';

import { PACING_DEFAULTS, type PacingKnobs, type WarmupStep } from './defaults';
import { decidePacing, tetoDoDia } from './engine';

/** Segunda, 16/11/2026, 10h de São Paulo: dentro da janela padrão (7h-22h). */
const AGORA = new Date('2026-11-16T10:00:00-03:00');
const DIA_MS = 86_400_000;
const CINCO_DIAS_NO_FUTURO = new Date(AGORA.getTime() + 5 * DIA_MS);

/** O "sem limite" do dia 10 gravado antes do degrau do dia 0. */
const FORA_DE_ORDEM: WarmupStep[] = [
  { minAgeDays: 10, cap: null },
  { minAgeDays: 0, cap: 10 },
];

const knobs: PacingKnobs = { ...PACING_DEFAULTS, warmupDailyCaps: FORA_DE_ORDEM, jitterMaxMs: 0 };

describe('ativação no futuro conta como idade 0 (aquecimento falha fechado)', () => {
  it('o teto do dia é o do degrau do dia 0, não o "sem limite" do primeiro da lista', () => {
    const teto = (numberActivatedAt: Date) =>
      tetoDoDia({ now: AGORA, knobs, numberActivatedAt, crmDailyLimit: null });
    expect(teto(AGORA)).toBe(10);
    expect(teto(CINCO_DIAS_NO_FUTURO)).toBe(10);
  });

  it('a 11ª abordagem do dia é vetada pelo aquecimento, e o motivo diz idade 0', () => {
    const decisao = decidePacing({
      now: AGORA,
      knobs,
      state: { lastSentAt: null, sentToday: 10, numberActivatedAt: CINCO_DIAS_NO_FUTURO },
      crmDailyLimit: null,
      rng: () => 0,
    });
    expect(decisao).toMatchObject({ allow: false, code: 'warmup_cap' });
    expect(decisao.allow === false && decisao.reason).toContain('10/dia para número com 0 dia(s) de idade');
  });
});
