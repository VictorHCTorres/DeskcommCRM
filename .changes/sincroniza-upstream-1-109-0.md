---
impacto: exige_acao
secao: alterado
titulo: A instalação recebe o produto do projeto original até a 1.109.0, e o que é próprio da Suindara continua
---

Esta versão incorpora as versões 1.100.0 a 1.109.0 do projeto original (melgarafael/DeskcommCRM), cada uma com a sua seção mais abaixo neste arquivo, e mantém tudo o que é próprio deste canal: a importação do ClickUp, as áreas e os grupos de funis com as visualizações salvas, o formulário público em `/f/<token>`, as subtarefas e as tarefas recorrentes, os anexos, comentários e relações das tarefas, e a chave externa e o token de servidor em `/api/v1/tasks`.

Por dentro, sem ação de quem opera:

- As migrations próprias deste canal passaram para a faixa 8xxx (eram 9093 a 9103 e 9338, números que o projeto original também usa). A atualização aplica o `baseline.sql` inteiro, então o banco não percebe a troca.
- Na tela de Tarefas chegam o filtro por funil e a visão em quadro do projeto original. O quadro mostra só as tarefas que casam com os filtros, sem o pai e as irmãs da subtarefa, e o número de tarefas em aberto no menu conta só as da própria pessoa.

## Requer atenção

Os avisos de ação do projeto original entre a 1.100.0 e a 1.109.0, reunidos aqui: a tela de atualização de quem está na 1.102.0 deste canal para no cabeçalho 1.102.0 do projeto original, que tem o mesmo número e é outra versão, e não chegaria aos três primeiros.

- **Contato do tipo Fornecedor sai do rodízio automático (1.100.0).** A conversa dele fica sem dono até alguém atribuí-la; no modo "Só os seus", o atendente não a vê enquanto estiver sem dono. Quem nunca marcou o tipo não é afetado.
- **A credencial reserva do canal oficial no `.env` vale só para o número dela (1.100.0).** O par `META_PHONE_NUMBER_ID`/`META_SYSTEM_USER_TOKEN` deixa de servir a outras conexões oficiais; uma conexão sem token legível fica como canal não conectado até ser reconectada.
- **Regra sobre as colunas de CPF responde só se estão preenchidas, e a API de contatos troca `cpf_hash` por `cpf_available` (1.104.0).** Regra que comparava o valor deixa de disparar (use "está preenchido"); integração que lia `cpf_hash` passa a ler `cpf_available`; modelo de mensagem que citava `contact.cpf_hash` ou `contact.cpf_encrypted` sai com o trecho em branco.
- **Cadastro só por convite: confira a chave (1.105.0).** Se você usa `SIGNUP_MODE=so_convite` e já salvou o comportamento, o molde de IA ou os destinos internos, abra Cadastro no painel da instalação e ligue Cadastro apenas por convite de novo.
- **O follow-up automático escolhe o agente pelo número da conversa (1.105.0).** Com mais de um número, confira que quem atende cada fluxo atende no número onde ele roda; o fluxo que disparava no número errado deixa de disparar.
- **Backup e pasta de anexos (1.109.0).** Com o Supabase na própria VPS, o backup do kit interrompe quando a pasta de anexos não existe, e a atualização para antes de mexer na instalação. Confira a pasta antes de atualizar. A atualização também troca a linha do crontab do dreno de eventos por um vigia de 15 em 15 minutos.
