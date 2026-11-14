---
impacto: nada_mudou
secao: adicionado
titulo: Linha A pode citar parcelamento em até 6x no cartão, desligado por padrão
---

Segunda opção da exceção da Linha A na trava "Deixar valores e negociação com a equipe", sem efeito até ser ligada por configuração (linha `restricao_comercial_excecao_funil_a_parcelamento` em `org_guardrail_layers`). Ligada, junto com a exceção da Linha A, a resposta do agente para o contato da Linha A pode citar parcelamento, "N vezes"/"Nx", cartão de crédito, "sem juros" e a expressão "link de pagamento"; passa a ser barrada a resposta com mais de 6 parcelas (em dígito ou por extenso), com "juros" que não seja "sem juros" ou com "débito". Continuam barrados qualquer valor em dinheiro diferente do `preco` do negócio (logo, valor de parcela), boleto, desconto, porcentagem, promessa de resultado, chave Pix, QR code, copia-e-cola e endereços. A opção é lida na mesma consulta do contato, sem consulta extra. Para todos os outros contatos, e para toda organização que não ligar a opção, o comportamento é o da 1.110.2. Não há migração. Crédito: @VictorHCTorres.
