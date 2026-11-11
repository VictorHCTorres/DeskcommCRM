---
impacto: capacidade_nova
secao: adicionado
titulo: Tarefas criadas por integração ganham chave externa única
---

`POST /api/v1/tasks` aceita o campo opcional `external_id` (de 1 a 200 caracteres, sem espaço nas pontas e sem caractere de controle). A chave é única por organização, garantida pelo banco: se outra tarefa já a tem, a resposta é `409` com o id dessa tarefa em `details.task_id`, e nada é criado. Quem grava por token pode assim repetir a chamada sem criar a mesma tarefa em dobro. `GET /api/v1/tasks` ganha os filtros `external_id` (exato, repetível até 100 vezes) e `external_id_prefix` (por prefixo), que devolvem só as linhas que casam, e passa a informar em `meta.total` o número exato de tarefas que casam com o filtro, mesmo quando a lista é cortada em 500. `PATCH /api/v1/tasks/{id}` preenche a chave de uma tarefa que ainda não tem; trocar ou apagar uma chave existente é recusado. Toda resposta dessas rotas traz o cabeçalho `x-tasks-external-id: 1`, para a integração confirmar que a instalação entende o campo antes de gravar. Exige aplicar a migration 9252 (aditiva: a coluna nasce vazia e nenhuma tarefa existente muda). Crédito: @VictorHCTorres.
