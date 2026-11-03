---
impacto: capacidade_nova
secao: adicionado
titulo: Importação revisável do ClickUp
---

O Deskcomm passa a preparar snapshots do ClickUp no servidor ou em storage privado, com mapeamento explícito por List e execução retomável. CRM e Conhecimento usam leases independentes, receipts duráveis e aplicação `create_only`; Docs sem conteúdo ficam bloqueados.

A importação agora também aceita um sidecar versionado de comentários e anexos. Os arquivos passam por quarantine privada, conferência de tamanho, SHA-256 e MIME real antes da promoção; downloads revalidam o tenant e o alvo. Comentários entram como histórico sem disparar automações, CAPI ou alterar o relógio comercial. Bundles antigos continuam marcados como `unknown_not_exported`, sem inventar cobertura.
