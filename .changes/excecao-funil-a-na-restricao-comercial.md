---
impacto: nada_mudou
secao: adicionado
titulo: Exceção da Linha A em "valores e negociação com a equipe", desligada por padrão
---

A trava "Deixar valores e negociação com a equipe" ganha uma opção, desligada por padrão e sem efeito até ser ligada por configuração (linha `restricao_comercial_excecao_funil_a` em `org_guardrail_layers`). Ligada, ela vale só para o contato com a etiqueta `funil-a` que tem exatamente um negócio aberto no funil Prospecção com o campo `preco` preenchido: a pergunta dele sobre preço, valor, Pix ou desconto deixa de ir direto para uma pessoa e segue para o agente, e a resposta do agente só sai se todo valor em dinheiro for igual ao `preco` do negócio, sem desconto, parcelamento, cartão, boleto, porcentagem, chave Pix, copia-e-cola, link de pagamento nem promessa de resultado, e com a referência `funilA:` seguida do código do negócio quando houver referência. Resposta barrada não sai, e a conversa vai para a Central, como já acontecia. Para todos os outros contatos, e para toda organização que não ligar a opção, o comportamento é o de antes. Não há migração. Crédito: @VictorHCTorres.
