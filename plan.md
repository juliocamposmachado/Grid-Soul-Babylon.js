# GRID SOUL — Atomic Forge 3D

## Objetivo e limite desta etapa

Implementar uma primeira fatia verificável sobre o checkout local do GRID SOUL, preservando a cena Three.js, o enxame de microcubos, a identidade química, a tabela periódica, a memória visual, a integração de IA e o agente de automação. As mudanças permanecem na cópia local; não houve `git fetch`, commit, push ou publicação.

Esta fatia entrega somente um garfo paramétrico de referência. Ela não completa a plataforma generativa e de fabricação descrita no pedido; os requisitos mais amplos permanecem registrados em `TODO.md`.

## Arquitetura implementada

- `public/engineering/fork.js` valida dimensões, constrói a forma do garfo e a extrusão CAD, calcula bounding box/volume/área/triângulos, verifica a malha e serializa STL binário.
- `public/engineering-ui.js` fornece painel sobreposto com parâmetros editáveis, prévia orbitável, corte, animação visual por camadas, material selecionado, métricas e downloads de STL/JSON/relatório.
- `components/material_catalog.js` contém seis grades comerciais com URLs de fabricante, condições de ensaio, ausências e divergências explicitadas.
- `lib/engineering/assistant.js` implementa parsing determinístico local e um prompt opt-in; respostas da IA são tratadas como proposta dimensional não executável e passam por validação local.
- `server.js` expõe somente as rotas locais de análise, catálogo e concessão de IA de uso único. Depois da confirmação no cliente, o servidor emite um token curto, vinculado à sessão SameSite e ao hash da descrição/finalidade/parâmetros; a análise exige metadados de mesma origem e consome esse token. Three.js 0.180 e seus addons são servidos localmente.
- `test/engineering.test.js` e `test/server.test.js` cobrem dimensões, malha fechada, contagem STL, fontes/snapshot do material, análise local e rejeição de consentimento ausente, payload alterado, replay ou origem não autorizada.
- `chrome-extension/background.js` reporta ID runtime e versão da cópia instalada em heartbeat local; `/api/health` expõe presença/ID recente como diagnóstico. O manifest não fixa `key`; o ID não é usado como autenticação. Ao receber uma consulta autorizada, reutiliza a aba ChatGPT aberta ou cria `chatgpt.com`, aguarda o carregamento e injeta `content.js` uma vez se o receptor não estiver ativo. O content script evita listeners duplicados, e o servidor identifica corretamente erros da ponte extensão versus CDP.

## Geometria, interface e unidades

O garfo é um perfil 2D com pontas arredondadas, pescoço e cabo, extrudado em espessura configurável para formar um sólido triangular. Os parâmetros suportados são comprimento, quantidade/comprimento/largura/vão dos dentes, pescoço, largura do cabo, largura da extremidade e espessura. Dimensões são milímetros. O painel 3D próprio é recolhível e coexistente com o palco original; não substitui os microcubos.

Volume, área, bounding box e contagem de faces são calculados sobre a malha construída. Massa é a estimativa teórica `volume CAD × densidade escolhida`, sob hipótese de 100% de volume sólido. Dados de TDS descrevem corpos de prova do grade e método/orientação indicados; não são garantias para a peça projetada. Campo não publicado permanece ausente. Referências e divergências estão em `docs/ATOMIC-FORGE.md` e no próprio catálogo.

STL binário e JSON/relatório são as únicas exportações disponíveis. A checagem de malha fechada não certifica imprimibilidade, resistência ou segurança. A animação em camadas é somente uma apresentação geométrica. 3MF, STEP, fatiamento/G-code, estimativa de consumo, tolerâncias, FEM, análise térmica, checagem de paredes/encaixes e impressão física permanecem sem implementação.

## Consentimento, privacidade e segurança

A análise determinística não envia dados externos. A chamada opcional à IA mostra a descrição, finalidade e dimensões e requer confirmação explícita; o token de uso único de curta duração vincula a sessão e o hash desses dados. Nenhum arquivo, pasta ou credencial é incluído. O servidor rejeita outra origem/host e finalidade não permitida. Isso protege contra replay e alterações de payload, mas não autentica outro processo executado sob a mesma conta local. Respostas geradas pela IA nunca viram código executável e dimensões passam por validação independente. Exportar arquivos requer ação do usuário e o STL apresenta confirmação de escala e limitações.

Nenhum CAD, solver, fatiador, gerador de G-code ou serviço externo é instalado ou acionado. O aplicativo permanece no loopback. O backup pré-etapa foi criado e a documentação limita-se ao comportamento realmente implementado.

## Design

**Direção:** oficina científica/cyberpunk coerente com o GRID SOUL. **Layout real da etapa:** painel Atomic Forge responsivo e sobreposto ao palco 3D existente, com viewport orbitável dentro do painel; o palco dos microcubos nunca é substituído. **Cores:** ciano `#48F5FF`, fundo azul-negro, verde apenas para estado de validação geométrica e âmbar para ressalvas. **Interações:** câmera, corte em espessura, animação visual progressiva e exportação explícita. **Princípio:** evidência/hipótese/limitação acompanham cada dado, sem sinais visuais que representem resistência mecânica não calculada.

## Validação registrada

Em 2026-10-21, `npm run check` e `git diff --check` passaram; a suíte executou 40 testes com 40 aprovados, incluindo o heartbeat que verifica ID runtime/versão da extensão sem chave fixa. Ela não lança Chromium/WebGL para renderizar a prévia Atomic Forge. Isso cobre código e integração local, não um ensaio físico, impressão real, sessão autenticada do ChatGPT ou compatibilidade de qualquer impressora.
