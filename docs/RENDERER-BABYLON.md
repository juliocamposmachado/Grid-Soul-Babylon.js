# Integração incremental do renderer Babylon.js

## Decisões apoiadas na documentação

A cena principal do GRID SOUL será renderizada pelo Babylon.js em uma única `Scene` com `ArcRotateCamera`. O enxame compartilha uma malha-base de cubo e buffers de thin instances; matrizes e cores são dados por instância, sem criar um Mesh JavaScript por microcubo. Os buffers que mudam durante animação precisam ser registrados como atualizáveis e marcados após a escrita direta. A cor customizada usa quatro componentes por instância.

WebGPU é opcional. O browser primeiro pede um adapter; sem adapter, pula direto para WebGL. A seleção e inicialização do `WebGPUEngine` acontecem antes de criar cena e recursos. Caso a inicialização falhe, o candidato é descartado e seu canvas é substituído por um canvas novo antes de inicializar o engine WebGL. Isso evita reutilizar um elemento cujo tipo de contexto possa ter sido fixado como WebGPU. Não se troca de backend depois que a cena já está carregada. Babylon é observado pelos hooks públicos de contexto perdido/restaurado; o loop suspende submits enquanto perdido e reanexa os buffers CPU quando restaura. WebGL continua sendo o caminho compatível.

O projeto permanece sem bundler: os módulos Babylon são servidos localmente do pacote fixado em `node_modules/@babylonjs/core`. `thinInstanceMesh.js` é importado explicitamente para registrar accessors e buffers do plugin antes de criar a mesh; sem esse side effect o contador podia ser um campo próprio sem ativar thin instances no GPU. Não se usa o global legado completo nem um CDN externo.

## Escopo preservado

A adaptação do plano mantém campos legados de shape, população, energia, escala, rotação, deslocamento, cor, partes, paleta e foco atômico. As funções existentes de posições do enxame, identidade química, amostragem facial e expressões continuam sendo a fonte dos dados. O renderer não executa texto ou código de IA. Atomic Forge e o Laboratório de Visão continuam como ferramentas separadas; seus canvases próprios ainda usam Three.js.

O enquadramento inicial é calculado sobre os limites da forma já transformada, com campo de visão e proporção reais do canvas; o ajuste acompanha a redimensionamento. Arrastar ou usar a roda no canvas entrega o controle ao usuário; **Enquadrar modelo** retorna ao ajuste automático.

As medidas de FPS, população visível, tempo de simulação/render e tamanho estimado dos buffers descrevem a sessão/navegador em execução. Elas não são garantia de desempenho em outro hardware. O orçamento inicial é de 100.000, 250.000 ou 500.000 instâncias conforme memória/threads/capacidades anunciadas; se FPS ficar abaixo de 25, o LOD reduz a quantidade visível, e após estabilidade acima de 48 FPS pode recuperá-la. A amostragem é determinística e uniforme sobre toda a população: em 500.000 slots com orçamento 100.000, mostra cada quinto slot. A população lógica, os dados de posição/cor e as identidades químicas não são descartados.

## Materiais e composição geométrica

O enxame usa um único `PBRMaterial` para manter uma chamada de desenho compacta, com albedo, metallic, roughness e emissive sanitizados pelo servidor. A IA pode selecionar `neutral`, `steel`, `aluminum`, `copper`, `iron`, `plastic`, `glass` ou `wood`; partes de objetos `custom` podem trazer sua cor RGB, que é aplicada no buffer de instância, sem reatribuir a identidade química. O preset `glass` é opaco e apenas visual. As peças compostas são primitivas voxelizadas (esfera/elipsoide/toro/cilindro/cone/caixa), limitadas a 24; um toro ou espaços entre primitivas podem sugerir aberturas, mas não há operação booleana CAD, extrusão/NURBS ou verificação de tolerâncias/fabricação.

O HUD mede FPS com uma janela real de frames do loop da aplicação, tempo do último `buildTargets`, simulação por frame e tempo CPU dentro de `scene.render()`. O rótulo “submissão CPU” não mede conclusão GPU; a memória reportada é estimativa dos buffers CPU do renderer, não VRAM ou memória total do navegador.

## Ensaios realizados

Após registrar explicitamente `thinInstanceMesh.js`, os smoke tests em Chromium/SwiftShader confirmaram que o HUD e a cena usam a mesma contagem real: esfera (6.000 e 20.900 cubos), casa composta (14.000), suporte com toro visual (18.000) e rosto pelo atlas (88.000). Os quatro modelos apareceram visualmente, sem erros JavaScript; a esfera de 20.900 cubos ocupou cerca de metade da altura do palco após o enquadramento automático, e o botão **Enquadrar modelo** respondeu. A face exibiu os detalhes RGB do atlas. No teste de carga de 209.000 slots, o HUD e a malha passaram a 150.000 visíveis quando o FPS medido ficou baixo. FPS em SwiftShader variou bastante durante capturas/transições; estes ensaios confirmam o contrato visual e funcional, não desempenho esperado em uma GPU física.

O caminho WebGL, carregamento local, canvas responsivo, fluxo de planos JSON, fallback após falha WebGPU simulada e perda/restauração via `WEBGL_lose_context` foram verificados sem erros JavaScript. Este ambiente não ofereceu adapter WebGPU real, portanto o caminho de inicialização WebGPU em hardware compatível ainda precisa de validação em dispositivo físico. Não foi realizado A/B quantitativo com o renderer Three.js antigo; módulos Three auxiliares permanecem disponíveis.

## Referências oficiais

- Thin Instances: buffers matriciais/atributos, buffer dinâmico, contagem e `thinInstanceBufferUpdated`.
- WebGPU: inicialização assíncrona e escolha do engine antes de construir a cena; WebGL mantido como backend compatível.
- ES modules e importações do core: organização modular e registro de efeitos colaterais para importações puras.
- Pacote instalado: `@babylonjs/core` versão `9.32.0`, consultada no registro npm.

[1]: https://doc.babylonjs.com/features/featuresDeepDive/mesh/copies/thinInstances "Thin Instances"
[2]: https://doc.babylonjs.com/setup/support/webGPU "WebGPU Support"
[3]: https://doc.babylonjs.com/setup/frameworkPackages/es6Support/treeShaking/usingPureImports/ "Using Pure Imports"
[4]: https://www.npmjs.com/package/@babylonjs/core "Babylon.js Core on npm"
