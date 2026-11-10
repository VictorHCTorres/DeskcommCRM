---
impacto: capacidade_nova
secao: adicionado
titulo: Integrações criam, listam e atualizam tarefas com token de API
---

`GET` e `POST /api/v1/tasks` e `PATCH /api/v1/tasks/{id}` passam a aceitar `Authorization: Bearer dsk_…`, além da sessão do navegador, pelo mesmo caminho de `PATCH /api/v1/leads/{id}`. Ler pede o escopo `mcp:read`, e criar ou alterar pede `mcp:write`. A organização vem do token, nunca do corpo da requisição. Como não há usuário nesse modo, a tarefa nasce sem autor e o registro de auditoria guarda o token. O filtro "minhas" (`assigned_to=me`) é recusado. Apagar tarefa, comentários, recorrência, anexos e relações continuam disponíveis só pela tela. Existe para robôs que antes criavam rotinas e prazos no ClickUp. Crédito: @VictorHCTorres.
