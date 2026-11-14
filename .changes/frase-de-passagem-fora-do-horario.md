---
impacto: nada_mudou
secao: adicionado
titulo: A frase do aviso de passagem pode ganhar um complemento fora do horário de atendimento
---

O agente que tem frase própria para o aviso de passagem (Agente › Configuração › "Frase do aviso de passagem") pode ter uma segunda frase, acrescentada só fora do horário de atendimento humano, por exemplo "Ele te responde no próximo dia útil, a partir das 8h." Ela fica em `aviso_de_handoff_fora_do_horario`, na configuração do agente, e o horário em `aviso_de_handoff_expediente` (fuso, dias, início e fim); sem o horário, vale segunda a sexta, das 8h às 18h, no fuso de São Paulo. Feriado não é considerado. Ainda não há campo na tela: grava-se pela API do agente. Sem a chave, nada muda. Não há migração. Crédito: @VictorHCTorres.
