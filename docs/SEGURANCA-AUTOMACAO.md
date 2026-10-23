# Segurança da automação local

## Execução e alcance

O servidor do GRID SOUL é destinado a uso na máquina em que o Node.js roda e continua escutando apenas em `127.0.0.1`. Não exponha a porta `8765` à rede nem publique esta aplicação como serviço remoto: execução de processos e acesso a arquivos só têm sentido no dispositivo local. A API de automação também valida Host, Origin e Fetch Metadata para rejeitar chamadas cruzadas comuns; isso não autentica processos locais do mesmo usuário/host.

As categorias terminal, arquivos, programas e navegador começam desligadas. Ativar uma categoria requer confirmação do usuário; a ação não concede escopo ilimitado. Para arquivos, cada diretório precisa de uma concessão separada. Para a Web, cada origem HTTPS é concedida individualmente. Desativar uma categoria interrompe suas tarefas; desativar arquivos ou navegador também remove os respectivos escopos. Tarefas pendentes de aprovação expiram após dois minutos. O botão “INTERROMPER TUDO AGORA” cancela tarefas em execução, aguarda seus executores e fecha o contexto Playwright. Um efeito iniciado pode não ser reversível; programas nativos já iniciados/desanexados precisam ser encerrados pelo usuário.

## CLI e terminal nativo

O terminal integrado não usa shell: a entrada é tokenizada, não aceita encadeamento, redirecionamento, substituição de comandos/variáveis nem comandos desconhecidos. A lista atual é `pwd`, `date`, `whoami`, `uname`, `ls`, `cat`, `head`, `tail`, busca textual literal `grep`, `git status`, `git log -N`, `git diff --stat` e consultas de versão de Node/npm/Python. Arquivos lidos por CLI obedecem às mesmas pastas concedidas, limites de tamanho e bloqueios de credenciais.

Abrir o terminal nativo é uma ação separada que solicita aprovação. O terminal nativo é um programa do próprio sistema e fica fora dos filtros da interface integrada; use-o somente se deseja deliberadamente operar diretamente no shell do sistema. O executor interno nunca passa o comando livre para `sh`, PowerShell ou `cmd`.

## Arquivos e processos

Caminhos são canonizados e limitados a diretórios concedidos; traversal, symlinks finais e pastas-pai são verificados antes da operação. Uma corrida contra outro processo local que altere simultaneamente a árvore concedida — inclusive uma troca de symlink entre checagem e abertura/leitura/commit — não é eliminada por APIs portáveis Node.js; não conceda pastas graváveis por outros processos nem use o app como sandbox contra malware local. Arquivos `.env*`, diretórios Git/perfis e caminhos conhecidos de chaves/credenciais são bloqueados; a denylist é defesa adicional, não substitui conceder uma pasta pequena. Leituras são apenas texto e têm limite de 256 KiB; escritas também são limitadas a 256 KiB. Criar, sobrescrever, criar pasta, mover/renomear e excluir requer confirmação da solicitação e uma segunda aprovação ligada à tarefa; exclusão de diretórios inteiros e sobrescrita durante criação/movimento são bloqueadas. Movimentações de arquivo dependem de hard link atômico, não atravessam volumes diferentes. Processos CLI são iniciados com `spawn`, `shell:false`, ambiente reduzido, saída limitada e timeout, mas continuam executando como o usuário do processo — não há sandbox de kernel.

A lista de programas é fixa: navegador do sistema apontando para o próprio GRID SOUL, calculadora e editor de texto. A abertura de um programa também exige aprovação por tarefa.

## Playwright e dados Web

Playwright cria um navegador/contexto isolado e temporário, sem anexar ao Chrome existente, importar cookies, ler armazenamento local, acessar perfis salvos ou registrar credenciais. O modo padrão é sem janela. Para permitir que a pessoa faça login manualmente, configure `GRID_SOUL_AUTOMATION_HEADLESS=0` antes de iniciar o servidor; o GRID SOUL ainda não automatiza campos de senha. Uma origem de autenticação/SSO redirecionada precisa de concessão própria.

A ponte de IA agora usa Playwright/CDP como padrão e não precisa da extensão Chrome. Ela se conecta ao endpoint local de depuração do Chrome em `127.0.0.1:9222`, reutiliza somente uma aba cuja origem seja exatamente `https://chatgpt.com` ou `https://chat.openai.com` e, se não houver, abre ChatGPT em uma nova aba. O usuário inicia o Chrome deliberadamente com um perfil exclusivo do GRID SOUL e faz login manualmente; o GRID SOUL insere o prompt no campo de conversa e lê a resposta visível para validar o JSON do plano. Não reutilize o perfil pessoal: o endpoint CDP concede controle amplo sobre as abas e a sessão do perfil a processos locais capazes de alcançá-lo. Não encaminhe nem exponha a porta `9222` pela rede. O servidor continua escutando apenas em `127.0.0.1`. Se `GRID_SOUL_CHATGPT_BRIDGE=extension` estiver definido explicitamente, a ponte antiga da extensão ainda pode ser selecionada; seus endpoints CORS são restritos a origens `chrome-extension://` válidas. A extensão não é mais o modo padrão.

Mensagens do Chrome `DEPRECATED_ENDPOINT`/`QUOTA_EXCEEDED` em `google_apis/gcm/engine/registration_request.cc` referem-se ao registro push interno do navegador. A extensão GRID SOUL usa `chrome.alarms` e HTTP loopback, não GCM/Firebase; use o heartbeat em `/api/health` e o inspetor do service worker para verificar a ponte.

Somente tráfego HTTPS para origens explicitamente concedidas é aceito — isso também vale para redirecionamentos, APIs e recursos de terceiros; conceda cada origem necessária separadamente. WebSockets usam WSS e ficam limitados à mesma origem concedida. Service workers são bloqueados. O Chromium usa um proxy efêmero em loopback: cada túnel CONNECT só aceita a origem concedida, resolve DNS novamente, rejeita respostas mistas/privadas/reservadas e conecta diretamente ao IP público validado, preservando TLS/SNI do domínio. Assim, uma troca DNS entre validação e conexão não muda o IP do túnel. O bloqueio adicional de QUIC e UDP não proxied reduz rotas diretas. Isso não é sandbox de rede/OS: não executa como administrador/root, não exponha o app, e trate o Chromium/Node como processos do mesmo usuário. A leitura visível exige aprovação e o texto extraído (máximo 5.000 caracteres) fica em memória/API por até 60 segundos; o cartão da interface pode mantê-lo visível até recarregar/substituir a página. Esse conteúdo nunca vai à auditoria.

Leitura de texto é limitada a 5.000 caracteres. Preencher qualquer campo e clicar em qualquer botão/link requer aprovação individual com os detalhes apresentados antes da execução. Campos de senha, arquivo, tokens e campos detectados como financeiros/credenciais são bloqueados. Para operações financeiras, envio de dados pessoais ou efeitos de conta, leia a página e revise cuidadosamente antes de aprovar o clique: automação não consegue desfazer efeitos externos.

## Auditoria, armazenamento e dados

`data/automation/permissions.json` guarda categorias e escopos locais; `audit.jsonl` guarda somente timestamp, categoria, tipo de ação, estado e ID interno da tarefa. Os argumentos completos de CLI, conteúdo de arquivo, valores de formulário, texto de páginas e saída de comandos não são gravados no arquivo de auditoria. A memória visual migra texto livre salvo anteriormente para estado gráfico e não grava novos prompts/respostas. Arquivos de automação ficam ignorados pelo Git; no POSIX a pasta usa modo `0700` e os arquivos `0600`. O histórico é rotacionado em aproximadamente 2 MiB. A interface mostra saídas e erros enquanto a sessão permanece ativa.

Proteja a conta do sistema operacional e mantenha a aplicação atualizada. O contexto Web ativo permanece aberto até fechar o navegador, revogar a permissão ou encerrar o processo.

## Instalação e execução

Use Node.js 20 ou superior, execute `npm ci` e instale o Chromium do Playwright uma vez com `npx playwright install chromium`. Depois execute `npm start` e abra `http://127.0.0.1:8765/`. Para iniciar navegador visível para login manual:

```bash
GRID_SOUL_AUTOMATION_HEADLESS=0 npm start
```

Em Windows, defina a variável de ambiente na sessão antes de iniciar `npm start`. Nunca coloque senhas, cookies, tokens ou perfis de navegador em `.env`, logs, comandos ou arquivos de teste.
