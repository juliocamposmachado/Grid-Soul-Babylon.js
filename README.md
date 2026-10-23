<img width="1333" height="764" alt="image" src="https://github.com/user-attachments/assets/c1aa3529-2727-45cd-ade6-586ab9c82f40" />

# GRID SOUL — Rosto de referência em cubos

**O ChatGPT planeja; no rosto, somente instâncias cúbicas formam a imagem.**

GRID SOUL é uma aplicação 3D local em Babylon.js, Node.js e Express. O palco principal é renderizado por Babylon com thin instances e material PBR; WebGPU é tentado quando disponível, com fallback para WebGL em um canvas novo. Three.js ainda fornece utilitários matemáticos legados e os renderers isolados de Atomic Forge/Visão, mas não renderiza o palco principal. A versão 1.5.0 conserva formas, identidade química por slot e ponte opcional com ChatGPT. O modo facial é uma reconstrução voxel frontal: posições e valores RGB são amostrados de uma grade 384×384 e cada amostra se torna um microcubo.

A fotografia não é carregada ou desenhada no palco: não há imagem, sprite, textura facial, plano, malha de rosto nem população orbital adicional. A geometria-fonte é um cubo Babylon instanciado em GPU; no modo facial, o `PBRMaterial` opera sem iluminação (`unlit`) e preserva as cores vertex RGB amostradas. O arquivo binário contém 88.000 registros compactos, não pixels exibidos como textura.

## O que esta versão oferece

- Face frontal reconstruída por 88.000 cubos, incluindo cubos coloridos espalhados ao redor, conforme aparecem na referência.
- Palco Babylon.js com câmera orbital, materiais PBR e thin instances (plugin registrado explicitamente); enquadramento automático pela extensão real do modelo e viewport, botão **Enquadrar modelo**, controle manual preservado e amostragem visual adaptativa conforme o orçamento observado do dispositivo.
- IDs químicos determinísticos e persistentes por slot: `Z = (slot mod 118) + 1`.
- Animação curta até os destinos amostrados; depois, os próprios cubos das regiões dos olhos piscam a cada 10 segundos e os da boca se movem em pulsos contínuos, sem áudio nem geometria extra.
- O modo facial não adiciona deriva, orbita cubos fora do atlas nem muda suas cores por uma paleta concorrente; as animações só deslocam/comprimem os cubos já amostrados.
- Esfera, toro, espiral, onda, nuvem, terreno, formas personalizadas, controles de câmera/zoom, população/energia, memória local e catálogo dos 118 elementos preservados.
- Paleta química multicolorida por padrão, instruções à IA para população/escala proporcionais ao pedido, tamanho independente dos microcubos e energia coletiva separada.
- Perfis PBR validados (`steel`, `aluminum`, `copper`, `iron`, `plastic`, `glass`, `wood`, `neutral`) e cores por componente em objetos compostos de primitivas voxelizadas.
- Laboratório de visão computacional local: análise de cores CIELAB, Canny/contornos, segmentação, desenhos de prioridade/exclusão, amostragem em cubos e projeto salvo localmente.
- Solicitação de correspondência exata com a referência escolhe automaticamente 88.000 slots, a menos que outra população seja informada explicitamente.

A imagem-fonte enviada permanece no projeto em [referencia-rosto-humanoide.png](referencia-rosto-humanoide.png), apenas para que o atlas possa ser regenerado. A execução usa o binário [public/assets/humanoid_face_88000.bin](public/assets/humanoid_face_88000.bin). A captura do ensaio WebGL está em [docs/ROSTO-3D-PREVIA.png](docs/ROSTO-3D-PREVIA.png); o perfil JSON original está em [docs/EXEMPLO-PERFIL-ROSTO.json](docs/EXEMPLO-PERFIL-ROSTO.json).

## Instalação

Requisitos: Node.js 20+, npm, Python 3 e navegador recente com WebGL. Babylon.js 9.32 e Three.js 0.180 são servidos localmente a partir das dependências npm; o palco tenta WebGPU e cai para WebGL sem CDN. O laboratório local usa NumPy, Pillow e OpenCV headless.

Extraia o ZIP em uma pasta nova; não misture arquivos com uma versão antiga e não abra o HTML diretamente.

```bash
npm ci
python3 -m venv .venv
.venv/bin/pip install -r requirements-vision.txt
npm start
```

Se a análise mostrar `ModuleNotFoundError: No module named 'cv2'`, o ambiente Python do projeto não recebeu as dependências. No mesmo diretório, execute novamente `python3 -m venv .venv` e `.venv/bin/pip install -r requirements-vision.txt`, depois reinicie o servidor. O módulo importado chama-se `cv2`, mas o pacote instalado é `opencv-python-headless`; não instale um pacote chamado `cv2`.

Abra [http://127.0.0.1:8765/?demo=1](http://127.0.0.1:8765/?demo=1). O servidor fica limitado ao loopback; não o exponha publicamente. A renderização facial funciona sem sessão de IA; para enviar comandos ao ChatGPT, configure CDP local ou a extensão Chrome conforme abaixo.

## Laboratório de Visão Computacional local

**Abrir Laboratório de Visão Computacional** analisa somente a imagem escolhida pelo usuário, mostra a referência e as camadas de bordas/cores/marcações, e renderiza o enxame em uma prévia 3D separada. A análise é executada localmente por Python/OpenCV; não transmite a imagem ao ChatGPT. Permite ajustar até 100.000 amostras, 8–128 cores, largura física e parâmetros de cubo. Projetos locais persistem após fechar o app em `data/vision-projects/` (ignorado pelo Git), além de existir download `.gridsoul.json`.

As saídas incluem captura PNG, paleta/coordenadas JSON, relevo voxelizado 2.5D STL e OBJ/MTL com cores de pré-visualização. Os exportadores STL/OBJ ficam limitados a 25.000 células. **Isso não é CAD industrial genérico:** não há formatos 3MF/STEP, G-code, fatiamento, simulação/fabricação certificada, envio direto à impressora ou mosaico para acumular mapas geográficos por blocos. STL não inclui cores; suporte a cores em MTL depende do software. Leia [docs/LOCAL_VISION_LAB.md](docs/LOCAL_VISION_LAB.md) para instalação, algoritmos, privacidade e limites de impressão.

## Formar o rosto da referência

No campo de comando, use, por exemplo:

> Reconstrua o rosto do anexo exatamente igual usando somente cubos.

A ponte identifica o pedido de fidelidade e seleciona 88.000 slots. O servidor aceita tanto o formato plano legado quanto o perfil canônico `object: "grid_soul_humanoid"`, `geometry.type: "human_face"`. Se escrever outra quantidade explicitamente, ela é respeitada. Em pedidos comuns sem solicitação de correspondência exata, os comandos mantêm a população corrente.

Após formar a face, ela pisca automaticamente uma vez a cada 10 segundos (a primeira piscada ocorre aproximadamente no fim do primeiro ciclo) e mantém um movimento labial rítmico para sugerir fala. É animação visual: não sintetiza voz nem analisa áudio.

O seletor de paleta fica travado em **Rosto — cores da referência** enquanto a face está ativa; isso evita que a coloração química ou uma paleta alternativa descaracterize o atlas. Ao sair da face, as opções normais voltam a funcionar. Os slots continuam com a mesma identidade química mesmo quando sua cor visual vem da referência.

## Limite de fidelidade e profundidade

O código aproxima a referência como uma imagem frontal voxelizada em cubos, mas **não garante igualdade pixel a pixel**: são 88.000 amostras em uma grade 384×384, renderizadas em um palco 3D com perspectiva, antialiasing e tamanhos de tela variáveis. A referência contém apenas uma vista frontal; o resultado é um relevo 2.5D raso, não uma cabeça volumétrica completa que reproduz igualmente todos os ângulos. Rotacionar a câmera mostra esse relevo de lado.

Amostras RGB e posições vêm da referência original, reduzida deterministicamente. No rosto, o material permanece sem iluminação para preservar a amostra de cor; a cena principal usa PBR fora desse modo. Os perfis PBR atuais aplicam um material global ao enxame; as cores por componente são instanced RGB. O preset `glass` é estilizado e opaco, não uma simulação de transparência. Peças compostas por cubos/primitive kinds são visualizações voxelizadas; não há booleanas CAD, superfícies NURBS, FEM, tolerâncias ou prova de fabricação. Bloom, profundidade de campo, transparência real e conectividade física entre cubos não são recursos separados nesta versão. O LOD adaptativo reduz apenas a quantidade submetida ao GPU quando o orçamento/performance requer, amostrando slots por toda a população; a população configurada, os dados de origem e o mapa químico não são truncados. A interface indica os efeitos pedidos que não estão implementados.

Para regenerar o atlas após trocar a fonte, mantenha o PNG no caminho acima e execute com Pillow instalado:

```bash
python3 scripts/generate_reference_voxels.py
```

A etapa offline descarta o fundo escuro, seleciona 88.000 amostras de cor/posição e grava o binário. O app em execução lê somente esse binário; nunca aplica o PNG como material.

## Atomic Forge 3D — garfo paramétrico

O botão **Abrir Atomic Forge 3D** inicia a primeira fatia funcional da oficina. Ela modela um garfo paramétrico editável como sólido extrudado, exibe uma prévia orbitável separada da cena de microcubos e fornece corte transversal, animação visual por camadas, bounding box, área, volume, contagem de triângulos e massa teórica quando existe densidade publicada. É possível baixar STL binário, projeto JSON e relatório técnico.

A análise local não envia dados externos. A opção ChatGPT fica desmarcada por padrão e cada solicitação exibe a descrição, finalidade e dimensões antes de exigir confirmação. Após a aprovação, o servidor emite um token curto, de uso único e ligado ao payload/sessão; isso evita replay, mas não autentica outros processos da mesma conta local. A resposta é apenas uma proposta dimensional e passa por validação local. A seleção de material oferece seis grades Polymaker, com TDS oficiais, condições de ensaio, ausências e divergências preservadas. Os arquivos JSON e relatório levam consigo o snapshot do grade, a densidade/fonte e as ressalvas; o catálogo não promete que propriedades de corpos de prova valham para a peça impressa.

Este marco **não** implementa suporte CAD genérico, tabela atômica ampliada, FEM, simulação térmica, checagem de espessura/encaixes, tolerâncias, estimativa de consumo do slicer, fatiamento/G-code, 3MF, STEP ou impressão física. A animação por camadas é visual e não simula processo de fabricação; massa assume 100% de volume sólido. O STL requer confirmação e unidade deve ser conferida ao importar. Leia [docs/ATOMIC-FORGE.md](docs/ATOMIC-FORGE.md) para uso, fontes e limitações. Os requisitos completos continuam em [TODO.md](TODO.md).

## Agente de automação local

O painel **Agente de automação local** adiciona permissões separadas para terminal, arquivos, abertura de programas e Playwright. Todas começam desligadas. Conceda apenas diretórios e origens HTTPS que pretende usar; navegar/ler páginas, preencher campos, clicar, abrir programas e criar/editar/mover/excluir arquivos aguardam aprovação por tarefa. As origens de recursos Web também precisam ser concedidas uma a uma. O terminal integrado não executa shell livre: aceita apenas comandos validados e limita operações de arquivos aos diretórios autorizados. Abrir o terminal nativo é uma opção separada e explícita, fora dos filtros do terminal integrado.

O Playwright para navegação comum usa um contexto isolado temporário e sem cookies/perfis existentes; por padrão é headless. Se desejar entrar manualmente em um site na janela Playwright, defina `GRID_SOUL_AUTOMATION_HEADLESS=0` antes de iniciar o app, autorize a origem principal e cada origem de autenticação/recursos necessária, e faça login manualmente. Campos de senha não podem ser preenchidos pela automação. Para a ponte de IA, o padrão agora é Playwright/CDP em um Chrome separado com perfil dedicado; não precisa instalar nem manter a extensão. O CDP dá ao processo local acesso ao navegador desse perfil, portanto não reutilize seu perfil pessoal. A auditoria conserva somente metadados de ações, sem valores de formulários, conteúdo da página, comandos/argumentos ou saída de processos. A memória visual migra texto livre antigo para estado gráfico e não grava novos prompts/respostas. Revogue categorias/escopos ou use **INTERROMPER TUDO AGORA** para cancelar tarefas.

Para instalar o navegador Playwright local uma vez, use `npx playwright install chromium`. Os limites e decisões de segurança estão em [docs/SEGURANCA-AUTOMACAO.md](docs/SEGURANCA-AUTOMACAO.md). Não exponha o servidor do app a redes públicas.

## Ponte com ChatGPT

`npm ci` instala dependências, mas não inicia o aplicativo. Sem `.env`, a ponte padrão é Playwright/CDP na porta local `9222`; a extensão Chrome não é necessária. Se existir um `.env` antigo com `GRID_SOUL_CHATGPT_BRIDGE=extension`, mude-o para `cdp` ou remova essa variável.

Antes de iniciar o servidor, abra um terminal e execute o Chrome com um perfil dedicado do GRID SOUL:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.config/gridsoul-chrome"
```

Na janela que abrir, entre manualmente em `https://chatgpt.com/` e deixe-a aberta. Em outro terminal, execute `npm start` e abra `http://127.0.0.1:8765/`. Ao enviar um comando, o GRID SOUL conecta-se ao Chrome por CDP, navega para `chatgpt.com` se necessário, coloca o pedido no campo de conversa, envia-o e lê a resposta JSON para validar/aplicar o plano. O texto **não** é colado na barra de endereço: ela serve somente para abrir o site; o pedido é inserido no compositor de mensagens do ChatGPT.

Se a consulta falhar, confira se o Chrome dedicado continua aberto e autenticado e se o terminal do GRID SOUL indica conexão CDP na porta `9222`. Não envie o mesmo pedido em várias abas do GRID SOUL enquanto a primeira consulta estiver aguardando; uma única resposta JSON validada atualiza o enxame.

Para verificar a conexão local, consulte `http://127.0.0.1:8765/api/health`: `bridge` deve ser `cdp`; após a primeira consulta, `browserReady` deve ficar `true`. `extension` será `null`, pois não há extensão envolvida. Se a conexão falhar, confirme que o Chrome foi iniciado com a porta `9222`, permaneça aberto e esteja autenticado em ChatGPT no perfil dedicado.

O modo CDP fica limitado ao loopback local e ao perfil que você iniciou deliberadamente para o GRID SOUL. Não compartilhe a porta `9222`, não a encaminhe pela rede e não reutilize seu perfil pessoal: quem alcança o endpoint CDP pode controlar as abas daquele perfil. A extensão antiga continua disponível apenas se você definir explicitamente `GRID_SOUL_CHATGPT_BRIDGE=extension`; não é necessária para o fluxo padrão.

Não distribua `.env`, perfis/cookies ou dados pessoais do navegador. A conversa de IA é processada pelo ChatGPT conforme a conta e suas configurações; o servidor local permanece no loopback. A memória mantém apenas parâmetros visuais e metadados, não armazena novos comandos ou respostas livres.

## Testes

```bash
npm ci
npm test
npm run check
.venv/bin/python -m unittest discover -s test/vision -v
```

A suíte verifica identidade química, atlas, animação, memória, API, perfis PBR e peças compostas, segurança local, consentimento, engenharia paramétrica e integração da visão local; testes Python verificam cores, contornos, máscaras e proporções; testes de malha verificam contagem/normais STL e materiais OBJ/MTL. Smoke tests Chromium exercitaram esfera, casa, suporte, rosto e LOD de 500 mil; os resultados/limitações estão em [docs/RENDERER-BABYLON.md](docs/RENDERER-BABYLON.md). Eles não lançam sessão autenticada do Chrome, validam todos os CADs/slicers ou certificam uma impressão física.

## Privacidade e arquivos

`data/gridsoul-memory.json` é local e não é empacotado. Backups recebidos permanecem em `historico/originais/`, mas não são carregados pela aplicação. O ZIP exclui `node_modules`, `.git`, `.env`, memória, cookies e perfis do navegador.


---

# GRID-SOUL
