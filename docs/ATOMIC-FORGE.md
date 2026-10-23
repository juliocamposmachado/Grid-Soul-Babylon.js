# Atomic Forge 3D — primeira fatia funcional

O Atomic Forge adiciona ao GRID SOUL uma oficina local para construir e exportar um garfo paramétrico. A cena original dos microcubos, a tabela dos 118 elementos, a memória visual, o agente de automação e a ponte existente de IA continuam separados e preservados.

## Usar a oficina

No Node.js 20+, rode `npm ci`, `npm run check` e `npm start`. Abra `http://127.0.0.1:8765/` e selecione **Abrir Atomic Forge 3D**. O servidor continua vinculado ao loopback; não o publique nem o exponha à rede. Three.js 0.180 e seu OrbitControls são servidos da dependência local do projeto.

A descrição e os campos dimensionais são editáveis. A análise determinística funciona localmente e reconhece pedidos de garfo com comprimento explicitamente identificado, número de pontas e espessura. Ela registra sugestões e perguntas, mas não altera o sólido por conta própria. Para pedir uma proposta à ponte ChatGPT, marque a opção de IA e aprove o diálogo que apresenta a descrição, a finalidade selecionada e as dimensões que serão enviadas. Após a aprovação, o cliente solicita um token de uso único, ligado por hash ao payload exato e a um cookie HttpOnly/SameSite, válido por dois minutos; o endpoint de análise exige também metadados da mesma origem. A resposta é tratada como proposta, limitada aos parâmetros permitidos, validada de novo no servidor e apresentada para revisão. Nenhum arquivo, pasta ou credencial é anexado.

Esse token previne replay e alteração acidental do payload, mas não é uma fronteira de segurança contra outro processo executando sob a mesma conta local: tal processo pode interagir com o servidor ou com a sessão do navegador. O app não autentica PIDs locais; mantenha-o no loopback e não execute software local não confiável.

Depois de ajustar os campos, selecione **Construir prévia do sólido**. A geometria extrudada é um único sólido triangular, orbitável e recortável. **Construir por camadas** é uma animação visual da geometria, não uma simulação de impressão nem código G. Alterar os parâmetros invalida a prévia existente; construa outra antes de exportar.

A oficina calcula bounding box, área superficial, volume triangulado e contagem de triângulos a partir da malha construída. Para um material que publica densidade, exibe massa teórica igual ao volume CAD multiplicado por essa densidade, assumindo 100% de volume sólido. O JSON guarda um snapshot versionado do grade, densidade usada, ressalvas e fontes rotuladas; o relatório inclui a nota de densidade e a fonte associada ao valor usado. Isso não estima consumo do fatiador, preenchimento real, suportes ou massa final. O STL binário exige malha fechada validada e confirmação final; como STL não registra uma unidade confiável, confirme milímetros ao importar. JSON e relatório técnico baixam para o computador quando solicitados. Nenhum fatiador, G-code ou impressão é iniciado.

## Materiais documentados

O catálogo contém seis grades de filamento do fabricante Polymaker, não seis materiais universais. Os TDS dizem que muitos valores são típicos e servem para referência ou comparação; propriedades de peças impressas variam com processo, orientação, desenho e ambiente [1] [5] [8] [11] [15] [18]. Por isso os dados do fabricante não são garantias para a geometria produzida.

No PolyLite PLA, o TDS lista densidade de 1,17 g/cm³ a 23 °C; a descrição da loja oficial também mostra 1,19 g/cm³, enquanto a tabela técnica da própria página lista 1,17. A interface informa que a estimativa de massa usa o TDS e mantém a divergência visível [1] [2] [3] [4]. PolyLite PETG lista 1,25 g/cm³ a 23 °C no TDS [5] [6] [7].

Para PolyLite ABS, o PDF TDS V5.6 e a loja oficial indicam 1,04 g/cm³, mas a wiki oficial de TDS consultada lista 1,12 g/cm³; o catálogo conserva essa divergência ao lado do valor usado para a estimativa [8] [9] [10]. Para PolyLite ASA, as fontes oficiais divergem em resistência à tração, módulo flexural e condições recomendadas, além de apresentarem densidades distintas. Esses números permanecem atribuídos às respectivas fontes em vez de serem combinados [11] [12] [13] [14].

O TDS da PolyMide CoPA mostra grande diferença entre resultados secos e úmidos e não especifica o protocolo de condicionamento correspondente; a interface registra essa ressalva junto dos valores [15] [16] [17]. Para PolyMide PA6-CF, as fontes consultadas não publicam densidade, tração nem módulo flexural. Assim, a massa não é estimada. A página de produto hoje apresenta Fiberon PA6-CF20; os valores tabulados desse outro grade não foram transferidos. Uma declaração textual de HDT de 215 °C é atribuída ao PolyMide na página oficial, mas sem método ou condição de ensaio e permanece explicitamente qualificada [18] [19].

Nenhum dos dados certifica uso alimentar. O material, aditivos, impressora, bico, contaminação, acabamento e limpeza precisam de avaliação independente; a oficina nunca declara o garfo seguro para alimentos. Dados de custo, tolerância, resistência da peça, impacto, desgaste, tempo de impressão e compatibilidade com uma impressora específica não são inventados quando as fontes não os estabelecem.

## O que ainda não está implementado

Esta entrega é somente a primeira fatia, não a plataforma completa descrita no pedido. A geometria disponível é um garfo extrudado, sem furos, roscas, encaixes, cavidades, nervuras, tolerâncias de fabricação ou modelos genéricos. A tabela periódica e identidade química preexistentes não foram ampliadas para o escopo de propriedades de engenharia pedido. Não há centro de gravidade, análise estrutural/FEM, análise térmica, checagem de paredes mínimas, suportes, fatiamento, instalação automática, 3MF, STEP, simulação física ou impressão conectada. A visualização de camadas é cosmética/explicativa, não representa parâmetros reais de fabricação. A malha fechada permite validar alguns erros geométricos, mas não prova imprimibilidade, resistência nem segurança de uso.

## Verificação e arquivos

`npm run check` executa verificação de sintaxe e testes de Node/API, inclusive testes do perfil lógico 3D original. A suíte passou com 40 testes. O módulo de geometria testa validação de dimensões, sólido fechado, volume, bounding box e estrutura/contagem do STL binário. Testes integrados confirmam o serviço local de Three.js, os seis registros e suas fontes, a análise local, concessão de uso único ligada ao payload, descoberta do ID runtime da extensão e proteção contra origem Web cruzada. Não há teste automatizado que lance Chromium/WebGL para a prévia Atomic Forge; a captura existente em `docs/ROSTO-3D-PREVIA.png` não faz parte de `npm run check`. Os testes não substituem uma validação física, uma sessão autenticada real do ChatGPT, um fatiador ou ensaio mecânico.

A cópia pré-Atomic Forge, feita antes da ampliação, está em `GRID-SOUL-PRE-ATOMIC-FORGE-20261021.zip`. O catálogo e todas as URLs de ficha consultadas também estão em `components/material_catalog.js`. As alterações continuam locais: não foi feito commit, push ou publicação no GitHub.

## Referências

[1]: https://cdn.shopify.com/s/files/1/0548/7299/7945/files/PolyLite_PLA_TDS_EN_V5.4.pdf?v=1731949179 "TDS oficial Polymaker PolyLite PLA V5.4"
[2]: https://wiki.polymaker.com/polymaker-products/more-about-our-products/documents/technical-data-sheets/pla/polylite-tm-pla "Wiki oficial de TDS PolyLite PLA"
[3]: https://wiki.polymaker.com/polymaker-products/polymaker-filaments/prime-materials/functional-pla/polylite-tm-pla "Página oficial de produto PolyLite PLA"
[4]: https://shop.polymaker.com/products/polylite-pla "Loja oficial Polymaker PolyLite PLA"
[5]: https://cdn.shopify.com/s/files/1/0548/7299/7945/files/PolyLite_PETG_TDS_EN_V5.4.pdf?v=1731954068 "TDS oficial Polymaker PolyLite PETG V5.4"
[6]: https://wiki.polymaker.com/polymaker-products/more-about-our-products/documents/technical-data-sheets/petg-pet/polylite-tm-petg "Wiki oficial de TDS PolyLite PETG"
[7]: https://wiki.polymaker.com/polymaker-products/polymaker-filaments/prime-materials/petg/polylite-tm-petg "Página oficial de produto PolyLite PETG"
[8]: https://polymaker.com/wp-content/uploads/lana-downloads/TDS_Polymaker_PolyLite-ABS_V5.6_2025-12-30_EN.pdf "TDS oficial Polymaker PolyLite ABS V5.6"
[9]: https://shop.polymaker.com/products/polylite-abs "Loja oficial Polymaker PolyLite ABS"
[10]: https://wiki.polymaker.com/polymaker-products/more-about-our-products/documents/technical-data-sheets/abs-asa/polylite-tm-abs "Wiki oficial de TDS PolyLite ABS"
[11]: https://polymaker.com/product/polylite-asa "Página oficial de produto PolyLite ASA"
[12]: https://wiki.polymaker.com/polymaker-products/more-about-our-products/documents/technical-data-sheets/abs-asa/polymaker-tm-asa "Wiki oficial de TDS Polymaker ASA"
[13]: https://polymaker.com/wp-content/tech-docs/PolyLite_ASA_PIS_EN_V1.3.pdf "Ficha oficial de produto PolyLite ASA V1.3"
[14]: https://polymaker.com/library-upload/polylite-asa-tds/ "Biblioteca oficial de TDS PolyLite ASA"
[15]: https://polymaker.com/wp-content/uploads/lana-downloads/TDS_Polymaker_PolyMide-CoPA_V5.5_2026-01-06_EN.pdf "TDS oficial Polymaker PolyMide CoPA V5.5"
[16]: https://wiki.polymaker.com/polymaker-products/more-about-our-products/documents/technical-data-sheets/nylon/polymide-tm-copa "Wiki oficial de TDS PolyMide CoPA"
[17]: https://wiki.polymaker.com/polymaker-products/polymaker-filaments/prime-materials/nylon-pa/polymide-tm-copa "Página oficial de produto PolyMide CoPA"
[18]: https://polymaker.com/wp-content/tech-docs/PolyMide_PA6-CF_PIS_EN_V1.5.pdf "Ficha oficial de produto PolyMide PA6-CF V1.5"
[19]: https://polymaker.com/product/polymide-pa6-cf/ "Página oficial de produto PolyMide PA6-CF"
