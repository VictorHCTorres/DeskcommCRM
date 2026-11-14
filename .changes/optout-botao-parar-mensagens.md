---
impacto: nada_mudou
secao: corrigido
titulo: O botão "Parar mensagens" do modelo oficial passa a bloquear o contato
---

O toque no botão "Parar mensagens" de um modelo da API oficial chega como texto, com o rótulo do botão, e esse rótulo não era reconhecido como pedido de saída: quem tocava seguia recebendo. Agora "parar mensagens" (também "parar as mensagens", "parem com as mensagens", "não mande mais mensagem", "não envie mais mensagens", "cancelar mensagens" e "não me mande mais", com ou sem acento e em maiúsculas) bloqueia o contato na entrada, como "PARAR" e "SAIR" já bloqueavam, inclusive quando o botão chega só com o código interno (PARAR_MENSAGENS). O objeto continua obrigatório: "não quero parar o processo", "para mensagens de voz eu não consigo ouvir" e "como cancelar mensagens agendadas?" não bloqueiam. Não há migração. Crédito: @VictorHCTorres.
