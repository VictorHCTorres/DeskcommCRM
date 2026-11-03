---
impacto: capacidade_nova
secao: adicionado
titulo: Tarefas passam a aceitar subtarefas e repetição automática
---

Uma tarefa pode ser dividida em subtarefas de um nível, exibidas dentro da tarefa principal com progresso e aviso das filhas atrasadas. A lista mantém a família na faixa do prazo aberto mais urgente, para uma etapa vencida não ficar escondida sob o prazo mais distante da tarefa principal.

Ao criar uma tarefa principal, também é possível repeti-la diariamente, semanalmente ou mensalmente, no prazo agendado ou depois da conclusão. O cálculo conserva o horário local mesmo em mudanças de horário de verão e trata os dias 29, 30 e 31 como o último dia válido do mês. Cancelar a série impede novas ocorrências sem apagar o histórico. O scheduler da instalação recebe o novo trabalho automaticamente; nenhuma configuração manual é necessária.

No modo após conclusão, a ocorrência seguinte é criada no primeiro ciclo do scheduler depois de concluir a atual, já com o prazo futuro calculado a partir daquele instante. Retentar uma configuração que falhou não duplica a tarefa.
