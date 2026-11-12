// @vitest-environment node
/**
 * F4q · a mensagem composta que saiu EM PARTE leva a marca `saiuEmParte`.
 *
 * Um envio do agente pode ser várias mensagens físicas: as bolhas (`sendInBubbles`) e as fotos do
 * produto (`enviarComFotos`, que manda o texto pelas bolhas quando ele não cabe na legenda). Os
 * dois param no primeiro desfecho que não é de sucesso e devolvem o desfecho da ÚLTIMA mensagem
 * física. Quem conta a saída no limite diário do número (`runBeforeSend`) apaga o registro quando
 * o desfecho diz que nada saiu: com a 1ª bolha `sent` e a 2ª `failed`, ou `queued` (a sessão caiu
 * entre uma e outra), ele apagava o registro de uma mensagem que SAIU, e a campanha seguinte via
 * uma vaga a mais e o intervalo do número sem a bolha que saiu.
 *
 * O contrato: se uma mensagem física desta chamada saiu e a última não, o desfecho leva
 * `saiuEmParte: true`, com o mesmo `kind` que os chamadores leem. Se nada saiu nesta chamada (o
 * canal segurou, já tinha saído antes, falhou), não há marca. A cadeia que lê a marca está em
 * `tests/unit/registro-da-ia-antes-do-envio.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

import { enviarComFotos, type FotoParaEnvio } from '@/lib/agent-engine/agent/fotos-do-produto';
import { sendInBubbles, type BubbleOutcome } from '@/lib/agent-engine/agent/split-message';
import { erroSaiuEmParte } from '@/lib/agent-engine/saida-parcial';

const TRES_BOLHAS = 'Primeira parte.\n\nSegunda parte.\n\nTerceira parte.';
const FOTO: FotoParaEnvio = { storagePath: 'org/conversa/catalogo-1.jpg', mime: 'image/jpeg' };

/** O canal falso: devolve os desfechos na ordem e, acabada a lista, `resto`. */
function canal(kinds: string[], resto = 'sent') {
  const fila = [...kinds];
  return vi.fn(async (_corpo: string): Promise<BubbleOutcome> => ({ kind: fila.shift() ?? resto, messageId: null }));
}

function emBolhas(send: (corpo: string) => Promise<BubbleOutcome>) {
  return (corpo: string) =>
    sendInBubbles(corpo, { enabled: true, maxChars: 600, sleep: async () => {}, jitter: () => 0, send });
}

function comFotos(
  enviarTexto: (corpo: string) => Promise<BubbleOutcome>,
  enviarFoto: (foto: FotoParaEnvio, legenda: string) => Promise<BubbleOutcome>,
) {
  return { enviarTexto, enviarFoto, sleep: async () => {}, jitter: () => 0 };
}

describe('F4q · sendInBubbles: a marca de quem saiu em parte', () => {
  it.each([
    [['sent', 'failed'], 'failed'],
    [['sent', 'blocked'], 'blocked'],
    [['sent', 'sent', 'unavailable'], 'unavailable'],
    [['sent', 'queued', 'queued'], 'queued'],
    [['sent', 'already_sent', 'failed'], 'failed'],
  ])('%j: o desfecho é o da última (%s), com saiuEmParte', async (kinds, ultimo) => {
    const send = canal(kinds);

    const r = await emBolhas(send)(TRES_BOLHAS);

    expect(r).toMatchObject({ kind: ultimo, saiuEmParte: true });
    expect(send).toHaveBeenCalledTimes(kinds.length);
  });

  it.each([
    [['queued', 'failed']],
    [['already_sent', 'failed']],
    [['failed']],
    [['queued', 'queued', 'queued']],
    [['already_sent', 'already_sent', 'already_sent']],
  ])('%j: nada saiu nesta chamada, e não há marca', async (kinds) => {
    const r = await emBolhas(canal(kinds))(TRES_BOLHAS);

    expect(r.kind).toBe(kinds[kinds.length - 1]);
    expect(r.saiuEmParte).toBeUndefined();
  });

  it('tudo saiu: o desfecho é o sent da última, sem marca', async () => {
    const r = await emBolhas(canal(['sent', 'sent', 'sent']))(TRES_BOLHAS);

    expect(r).toStrictEqual({ kind: 'sent', messageId: null });
  });

  it('bolhas desligadas: uma mensagem só, e o desfecho dela, sem marca', async () => {
    const send = canal(['failed']);

    const r = await sendInBubbles(TRES_BOLHAS, {
      enabled: false,
      maxChars: 600,
      sleep: async () => {},
      jitter: () => 0,
      send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(r.kind).toBe('failed');
    expect(r.saiuEmParte).toBeUndefined();
  });
});

describe('F4q · enviarComFotos: a marca atravessa as fotos e as bolhas', () => {
  it('a capa saiu com a legenda e a foto seguinte falhou: failed, com saiuEmParte', async () => {
    const fotos = canal(['sent', 'failed']);

    const r = await enviarComFotos(
      'Legenda curta.',
      [FOTO, FOTO],
      comFotos(canal([]), (_foto, legenda) => fotos(legenda)),
    );

    expect(r).toMatchObject({ kind: 'failed', saiuEmParte: true });
  });

  it('a foto do meio falhou: as seguintes não saem, e a marca vai junto', async () => {
    const fotos = canal(['sent', 'failed', 'sent']);

    const r = await enviarComFotos(
      'Legenda curta.',
      [FOTO, FOTO, FOTO],
      comFotos(canal([]), (_foto, legenda) => fotos(legenda)),
    );

    expect(fotos).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ kind: 'failed', saiuEmParte: true });
  });

  it('o texto longo saiu em parte pelas bolhas (o resto ficou na fila do canal) e a foto falhou: a marca não se perde', async () => {
    const textoLongo = `${'Uma frase longa sobre o produto. '.repeat(40)}\n\nOutra parte.`;
    expect(textoLongo.length).toBeGreaterThan(1024); // passa do teto da legenda: o texto vai antes, em bolhas

    const r = await enviarComFotos(
      textoLongo,
      [FOTO],
      comFotos(emBolhas(canal(['sent'], 'queued')), async () => ({ kind: 'failed', messageId: null })),
    );

    expect(r).toMatchObject({ kind: 'failed', saiuEmParte: true });
  });

  it('o teto do turno corta as fotos depois de uma na fila do canal: a capa saiu, e a marca vai junto', async () => {
    let enviadas = 0;
    const fotos = canal(['sent', 'queued']);

    const r = await enviarComFotos('Legenda curta.', [FOTO, FOTO, FOTO], {
      ...comFotos(canal([]), (_foto, legenda) => {
        enviadas += 1;
        return fotos(legenda);
      }),
      restantes: () => 2 - enviadas,
    });

    expect(enviadas).toBe(2);
    expect(r).toMatchObject({ kind: 'queued', saiuEmParte: true });
  });

  it('a capa ficou na fila do canal e a seguinte falhou: nada saiu, sem marca', async () => {
    const fotos = canal(['queued', 'failed']);

    const r = await enviarComFotos(
      'Legenda curta.',
      [FOTO, FOTO],
      comFotos(canal([]), (_foto, legenda) => fotos(legenda)),
    );

    expect(r.kind).toBe('failed');
    expect(r.saiuEmParte).toBeUndefined();
  });
});

/**
 * F4q do cxj (Q01) · o erro que sobe DEPOIS de uma mensagem física desta chamada sair. A
 * organização parada lança (`OrgNaoOperanteError`) na mensagem seguinte, e a cadeia, que lê esse
 * erro como "nada saiu", apagava o registro da que saiu. O erro sobe o MESMO objeto, com a mesma
 * classe (a organização parada encerra o job), e a marca fica guardada fora dele:
 * `erroSaiuEmParte`. Quem lê a marca é `runBeforeSend`
 * (`tests/unit/registro-da-ia-antes-do-envio.test.ts`).
 */
describe('F4q do cxj (Q01) · o erro que sobe depois de uma saída leva a marca', () => {
  /** Classe local: o arquivo não importa o erro da organização (que puxa o handler da API). */
  class ErroDoCanal extends Error {}

  /** O canal falso: devolve os desfechos na ordem e, na chamada `lancarNa` (1 = a 1ª), lança. */
  function canalQueLanca(kinds: string[], lancarNa: number, erro: unknown) {
    const fila = [...kinds];
    let chamadas = 0;
    return vi.fn(async (_corpo: string): Promise<BubbleOutcome> => {
      chamadas += 1;
      if (chamadas === lancarNa) throw erro;
      return { kind: fila.shift() ?? 'sent', messageId: null };
    });
  }

  it.each([
    [['sent'], 2],
    [['sent', 'sent'], 3],
    [['queued', 'sent'], 3],
    [['sent', 'queued'], 3],
  ])('bolhas %j e a chamada %i lança: o mesmo erro sobe, marcado', async (kinds, lancarNa) => {
    const erro = new ErroDoCanal('a organização parou entre as bolhas');
    const send = canalQueLanca(kinds, lancarNa, erro);

    await expect(emBolhas(send)(TRES_BOLHAS)).rejects.toBe(erro);

    expect(send).toHaveBeenCalledTimes(lancarNa);
    expect(erroSaiuEmParte(erro)).toBe(true);
  });

  it.each([
    [[], 1],
    [['queued'], 2],
    [['already_sent', 'queued'], 3],
  ])('bolhas %j e a chamada %i lança: nada saiu nesta chamada, e o erro sobe sem marca', async (kinds, lancarNa) => {
    const erro = new ErroDoCanal('a organização parou');

    await expect(emBolhas(canalQueLanca(kinds, lancarNa, erro))(TRES_BOLHAS)).rejects.toBe(erro);

    expect(erroSaiuEmParte(erro)).toBe(false);
  });

  it('a pausa entre as bolhas lança depois de a 1ª sair: marcado', async () => {
    const erro = new ErroDoCanal('a pausa foi interrompida');
    const send = canal(['sent']);

    await expect(
      sendInBubbles(TRES_BOLHAS, {
        enabled: true,
        maxChars: 600,
        jitter: () => 0,
        sleep: async () => {
          throw erro;
        },
        send,
      }),
    ).rejects.toBe(erro);

    expect(send).toHaveBeenCalledTimes(1);
    expect(erroSaiuEmParte(erro)).toBe(true);
  });

  it('a capa saiu com a legenda e a foto seguinte lança: marcado', async () => {
    const erro = new ErroDoCanal('a organização parou entre as fotos');
    const fotos = canalQueLanca(['sent'], 2, erro);

    await expect(
      enviarComFotos('Legenda curta.', [FOTO, FOTO], comFotos(canal([]), (_foto, legenda) => fotos(legenda))),
    ).rejects.toBe(erro);

    expect(erroSaiuEmParte(erro)).toBe(true);
  });

  it('o texto longo saiu inteiro pelas bolhas e a 1ª foto lança: marcado', async () => {
    const erro = new ErroDoCanal('a organização parou antes da foto');
    const textoLongo = `${'Uma frase longa sobre o produto. '.repeat(40)}\n\nOutra parte.`;
    expect(textoLongo.length).toBeGreaterThan(1024); // o texto vai antes, em bolhas

    await expect(
      enviarComFotos(textoLongo, [FOTO], comFotos(emBolhas(canal([])), async () => Promise.reject(erro))),
    ).rejects.toBe(erro);

    expect(erroSaiuEmParte(erro)).toBe(true);
  });

  it('a 1ª bolha do texto longo saiu e a 2ª lança, dentro das fotos: a marca de dentro se mantém', async () => {
    const erro = new ErroDoCanal('a organização parou entre as bolhas do texto');
    const textoLongo = `${'Uma frase longa sobre o produto. '.repeat(40)}\n\nOutra parte.`;
    const foto = vi.fn(async (): Promise<BubbleOutcome> => ({ kind: 'sent', messageId: null }));

    await expect(
      enviarComFotos(textoLongo, [FOTO], comFotos(emBolhas(canalQueLanca(['sent'], 2, erro)), foto)),
    ).rejects.toBe(erro);

    expect(foto).not.toHaveBeenCalled();
    expect(erroSaiuEmParte(erro)).toBe(true);
  });

  it('a capa lança: nada saiu, sem marca', async () => {
    const erro = new ErroDoCanal('a organização parou antes da capa');

    await expect(
      enviarComFotos('Legenda curta.', [FOTO, FOTO], comFotos(canal([]), async () => Promise.reject(erro))),
    ).rejects.toBe(erro);

    expect(erroSaiuEmParte(erro)).toBe(false);
  });

  it('a marca é do objeto: um erro novo, da mesma classe, não a herda', async () => {
    const primeiro = new ErroDoCanal('primeira vez');
    await expect(emBolhas(canalQueLanca(['sent'], 2, primeiro))(TRES_BOLHAS)).rejects.toBe(primeiro);

    expect(erroSaiuEmParte(primeiro)).toBe(true);
    expect(erroSaiuEmParte(new ErroDoCanal('outra vez'))).toBe(false);
  });

  it('o que não é objeto sobe como veio, e não há onde guardar a marca', async () => {
    await expect(emBolhas(canalQueLanca(['sent'], 2, 'texto lançado'))(TRES_BOLHAS)).rejects.toBe('texto lançado');

    expect(erroSaiuEmParte('texto lançado')).toBe(false);
    expect(erroSaiuEmParte(null)).toBe(false);
    expect(erroSaiuEmParte(undefined)).toBe(false);
  });
});
