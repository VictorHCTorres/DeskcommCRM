---
impacto: nada_mudou
secao: adicionado
titulo: Etiqueta pix-pedido em contato da Linha A pode abrir um aviso crítico na Central
---

Opção nova, desligada por padrão e sem efeito até ser ligada por configuração (linha `linha_a_pix_pedido_na_central` em `org_guardrail_layers`). Ligada, quando um contato com a etiqueta `funil-a` e um negócio aberto no funil Prospecção ganha a etiqueta `pix-pedido` (pelo agente, pela tela ou por automação), a Central recebe um aviso crítico ligado ao negócio, com o serviço, o preço, o código e a referência `funilA:` seguida do código, para a equipe gerar a cobrança. O aviso não transfere a conversa, não cala o agente, não move o negócio de etapa e não envia mensagem; há um aviso aberto por negócio. Não há migração. Crédito: @VictorHCTorres.
