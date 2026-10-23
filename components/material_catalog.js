export const MATERIAL_CATALOG_VERIFIED_ON = '2026-10-21';

// Valores típicos de fabricante, não especificações garantidas de peças impressas.
// Divergências e dados não publicados permanecem explícitos; não combinar grades.
export const GRID_SOUL_MATERIALS = Object.freeze([
  Object.freeze({
    id: 'pla',
    brand_grade: 'Polymaker PolyLite™ PLA',
    polymer_and_reinforcement: 'PLA, conforme identificação do produto; formulação detalhada e reforço não informados.',
    density_g_cm3: 1.17,
    density_note: 'TDS: 1,17 g/cm³ a 23 °C (ISO 1183/GB/T 1033). A descrição da loja oficial também exibe 1,19 g/cm³; a tabela técnica da mesma página lista 1,17 g/cm³.',
    tensile_strength_mpa: 'X-Y: 52,3 ± 0,3 MPa; Z: 40,5 ± 0,5 MPa.',
    tensile_test_method_and_condition: 'ISO 527 e GB/T 1040. TDS distingue X-Y e Z; temperatura/condicionamento do ensaio não informado. A página oficial descreve X-Y como no plano das camadas e Z entre camadas.',
    flexural_modulus_mpa: 'X-Y: 3230,9 ± 55,3 MPa (ISO 178/GB/T 9341); Z: N/A na TDS.',
    thermal_property_and_test: 'Tg 61 °C; fusão 150 °C; cristalização 114 °C (DSC, 10 °C/min); decomposição 325 °C (TGA, 20 °C/min); Vicat 63 °C (ISO 306/GB/T 1633); HDT 58 °C a 1,8 MPa e 60 °C a 0,45 MPa (ISO 75).',
    recommended_print_settings: 'Bico 190–230 °C; mesa 25–60 °C; ventilador ligado; 50–200 mm/s; secagem 55 °C por 6 h; câmara fechada não necessária. Baseado em bico 0,4 mm; suporte e superfície dependem do caso. O fabricante não recomenda para impressão de alta velocidade.',
    caveats: 'TDS classifica os valores como típicos, somente para referência/comparação, não especificação de projeto ou controle de qualidade; a peça real varia com processo, desenho e ambiente. A resistência varia por orientação. A TDS mostra curva de absorção, sem valor quantitativo declarado. Densidade conflitante entre descrição e tabela na loja; o valor numérico usado na estimativa é o do TDS, e a divergência permanece visível. Dados não certificam peça nem contato alimentar.',
    source_urls: [
      'https://cdn.shopify.com/s/files/1/0548/7299/7945/files/PolyLite_PLA_TDS_EN_V5.4.pdf?v=1731949179',
      'https://wiki.polymaker.com/polymaker-products/more-about-our-products/documents/technical-data-sheets/pla/polylite-tm-pla',
      'https://wiki.polymaker.com/polymaker-products/polymaker-filaments/prime-materials/functional-pla/polylite-tm-pla',
      'https://shop.polymaker.com/products/polylite-pla'
    ],
    source_labels: ['TDS PDF PolyLite PLA V5.4', 'Wiki oficial — TDS PLA', 'Wiki oficial — produto PLA', 'Loja oficial — PolyLite PLA']
  }),
  Object.freeze({
    id: 'petg',
    brand_grade: 'Polymaker PolyLite™ PETG',
    polymer_and_reinforcement: 'PETG; reforços, cargas e detalhes de formulação não informados na fonte consultada.',
    density_g_cm3: 1.25,
    density_note: '1,25 g/cm³ a 23 °C, conforme TDS oficial.',
    tensile_strength_mpa: 'X-Y: 50,8 ± 0,9 MPa; Z: 42,8 ± 2,8 MPa.',
    tensile_test_method_and_condition: 'ISO 527 e GB/T 1040; resultados separados por orientação X-Y/Z. Corpos de prova: bico 240 °C, mesa 80 °C, 2 shells, 3 camadas superior/inferior, 100% infill, ambiente, ventilador desligado.',
    flexural_modulus_mpa: 'X-Y: 1898,5 ± 35,5 MPa (ISO 178/GB/T 9341); Z: N/A na ficha.',
    thermal_property_and_test: 'Tg 81 °C (DSC, 10 °C/min); Vicat 84 °C (ISO 306/GB/T 1633); HDT 75 °C a 1,8 MPa e 78 °C a 0,45 MPa (ISO 75). Fusão, cristalização e decomposição: N/A na ficha.',
    recommended_print_settings: 'Bico 230–260 °C; mesa 70–80 °C; ventilador OFF–20%; velocidade 50–100 mm/s; secagem 65 °C por 6 h; câmara fechada não necessária. Baseado em bico de 0,4 mm; armazenamento seco recomendado por sensibilidade à umidade.',
    caveats: 'Valores típicos apenas para referência/comparação, não especificação de projeto ou controle de qualidade. A resistência difere entre X-Y e Z. A ficha destaca absorção de umidade; o desempenho também depende da impressão, do projeto e do ambiente. Não é certificação de peça ou contato alimentar.',
    source_urls: [
      'https://cdn.shopify.com/s/files/1/0548/7299/7945/files/PolyLite_PETG_TDS_EN_V5.4.pdf?v=1731954068',
      'https://wiki.polymaker.com/polymaker-products/more-about-our-products/documents/technical-data-sheets/petg-pet/polylite-tm-petg',
      'https://wiki.polymaker.com/polymaker-products/polymaker-filaments/prime-materials/petg/polylite-tm-petg'
    ],
    source_labels: ['TDS PDF PolyLite PETG V5.4', 'Wiki oficial — TDS PETG', 'Wiki oficial — produto PETG']
  }),
  Object.freeze({
    id: 'abs',
    brand_grade: 'Polymaker PolyLite™ ABS',
    polymer_and_reinforcement: 'Resina ABS especial bulk-polymerized, conforme descrição oficial; reforço não informado.',
    density_g_cm3: 1.04,
    density_note: 'O TDS PDF oficial V5.6 indica 1,04 g/cm³ a 23 °C (ISO 1183/GB/T 1033), assim como a página da loja; a wiki oficial de TDS consultada lista 1,12 g/cm³. Mantido 1,04 do TDS PDF direto, mas a divergência oficial permanece.',
    tensile_strength_mpa: 'X-Y: 33,4 ± 0,6 MPa; Z: 29,7 ± 0,3 MPa.',
    tensile_test_method_and_condition: 'ISO 527/GB/T 1040; 100% infill. TDS: bico 260 °C, mesa 90 °C, ambiente 90 °C, 2 perímetros, 3 camadas superior/inferior e ventilador desligado. Página do produto identifica X-Y como através das camadas e Z como adesão entre camadas.',
    flexural_modulus_mpa: 'X-Y: 2127,2 ± 29,9 MPa (ISO 178/GB/T 9341); Z não informado.',
    thermal_property_and_test: 'HDT 98 °C a 1,8 MPa e 100 °C a 0,45 MPa (ISO 75); Tg 101 °C (DSC, 10 °C/min).',
    recommended_print_settings: 'Bico 245–265 °C; mesa 90–100 °C; ventilador OFF; câmara fechada necessária; velocidade 50–200 mm/s; secagem 70 °C por 6 h. Valores baseados em bico 0,4 mm.',
    caveats: 'Há conflito de densidade entre fontes oficiais (TDS/loja 1,04; wiki TDS 1,12 g/cm³). O TDS classifica valores como típicos e apenas comparativos, não especificação de projeto/controle de qualidade. Peças variam com parâmetros, desenho e ambiente; não inferir segurança alimentar.',
    source_urls: [
      'https://polymaker.com/wp-content/uploads/lana-downloads/TDS_Polymaker_PolyLite-ABS_V5.6_2025-12-30_EN.pdf',
      'https://shop.polymaker.com/products/polylite-abs',
      'https://wiki.polymaker.com/polymaker-products/more-about-our-products/documents/technical-data-sheets/abs-asa/polylite-tm-abs'
    ],
    source_labels: ['TDS PDF PolyLite ABS V5.6', 'Loja oficial — PolyLite ABS', 'Wiki oficial — TDS ABS']
  }),
  Object.freeze({
    id: 'asa',
    brand_grade: 'Polymaker PolyLite™ ASA',
    polymer_and_reinforcement: 'ASA (acrilonitrila-estireno-acrilato); a fabricante o descreve como alternativa ao ABS com resistência climática aprimorada; formulação detalhada/reforço não informado.',
    density_g_cm3: 1.13,
    density_note: 'TDS oficial: 1,13 g/cm³ a 23 °C (ISO 1183/GB/T 1033). PDF oficial antigo: 1,1 g/cm³ a 21,5 °C (ASTM D792/ISO 1183/GB/T 1033). As fontes não permitem reconciliar a diferença; valor de massa usa o TDS atual e preserva a discrepância.',
    tensile_strength_mpa: 'TDS: XY 43,8 ± 0,8 MPa e Z 32 ± 1,8 MPa. Página de produto: XY 38,6 ± 0,3 MPa e Z 30,0 ± 0,5 MPa. Divergência oficial não reconciliada.',
    tensile_test_method_and_condition: 'TDS: ISO 527/GB/T 1040, eixos XY/Z; corpos de prova com mesa 90 °C, ambiente 90 °C, ventilador OFF, 100% infill, 2 shells, 3 camadas superior/inferior. PDF antigo associa XY também a ASTM D638. Temperatura/velocidade/umidade do ensaio não totalmente informadas.',
    flexural_modulus_mpa: 'TDS: XY 3206 ± 108 MPa. Página oficial do produto: XY 1939,7 ± 50,4 MPa. Ambos citam ISO 178/GB/T 9341; Z não informado. Divergência oficial não reconciliada.',
    thermal_property_and_test: 'Página oficial: Tg 97,8 °C (DSC, 10 °C/min); HDT 100,2 °C a 1,8 MPa e 102,6 °C a 0,45 MPa (ISO 75); Vicat 105,3 °C (ISO 306/GB/T 1633). TDS arredonda para 98 °C, 100/103 °C e 105 °C. Temperatura de fusão também diverge entre fontes; não apresentada como propriedade confirmada.',
    recommended_print_settings: 'TDS: bico 230–260 °C; mesa 75–95 °C; câmara fechada necessária; ventilador OFF; 50–200 mm/s; secagem 70 °C por 7 h. Página do produto: bico 240–260 °C, 30–50 mm/s e secagem 70 °C/6 h apenas se úmido. PDF antigo recomenda secagem 80 °C/8 h. Os documentos oficiais divergem; verificar o TDS aplicável ao lote e à impressora.',
    caveats: 'Divergências oficiais relevantes em densidade, tração, módulo flexural e parâmetros de impressão; os valores e fontes foram mantidos separados e não reconciliados. As fontes dizem que valores são típicos, comparativos e dependentes de processo, desenho e ambiente. TDS alerta para umidade e ventilação/enclosure. Não é especificação de peça nem validação de contato alimentar.',
    source_urls: [
      'https://polymaker.com/product/polylite-asa',
      'https://wiki.polymaker.com/polymaker-products/more-about-our-products/documents/technical-data-sheets/abs-asa/polymaker-tm-asa',
      'https://polymaker.com/wp-content/tech-docs/PolyLite_ASA_PIS_EN_V1.3.pdf',
      'https://polymaker.com/library-upload/polylite-asa-tds/'
    ],
    source_labels: ['Página oficial PolyLite ASA', 'Wiki oficial — TDS ASA', 'PDF oficial — ficha ASA antiga', 'Biblioteca oficial — TDS ASA']
  }),
  Object.freeze({
    id: 'nylon',
    brand_grade: 'Polymaker PolyMide™ CoPA',
    polymer_and_reinforcement: 'Copolímero Nylon 6 e Nylon 6,6. A ficha consultada não declara explicitamente teor de carga/reforço nem confirma a designação “unfilled”.',
    density_g_cm3: 1.12,
    density_note: '1,12 g/cm³ a 23 °C (ISO 1183/GB/T 1033), conforme TDS oficial.',
    tensile_strength_mpa: 'Seco: X-Y 78,0 ± 0,7 MPa; Z 45,8 ± 1,5 MPa. Úmido: X-Y 34,3 ± 2,5 MPa; Z 13,7 ± 1,2 MPa.',
    tensile_test_method_and_condition: 'ISO 527/GB/T 1040. A ficha distingue X-Y/Z e seco/úmido, mas não define o protocolo de condicionamento dos estados; valores não são intercambiáveis.',
    flexural_modulus_mpa: 'Módulo de flexão (ficha: “Bending modulus”): seco X-Y 2510 ± 25 MPa; úmido X-Y 636 ± 11 MPa; Z N/A (ISO 178/GB/T 9341).',
    thermal_property_and_test: 'Vicat 180 °C (ISO 306/GB/T 1633); HDT 70 °C a 1,8 MPa e 111 °C a 0,45 MPa (ISO 75); Tg 66 °C, fusão 189 °C e cristalização 148 °C (DSC, 10 °C/min); decomposição 370 °C (TGA, 20 °C/min).',
    recommended_print_settings: 'Bico 250–270 °C; mesa 25–50 °C; ventilador desligado; câmara fechada à temperatura ambiente; 50–200 mm/s; secagem do filamento 100 °C por 8 h; recozimento 80 °C por 6 h; armazenamento abaixo de 20% UR recomendado. Bico 0,4 mm; bico resistente ao desgaste recomendado.',
    caveats: 'Nylon é muito sensível à umidade e os valores secos/úmidos divergem substancialmente. TDS não define o condicionamento dos corpos de prova para esses rótulos. A fabricante declara valores típicos para comparação, não especificação ou controle de qualidade; processo, peça e ambiente alteram resultados. Nenhuma certificação de contato alimentar é inferida.',
    source_urls: [
      'https://polymaker.com/wp-content/uploads/lana-downloads/TDS_Polymaker_PolyMide-CoPA_V5.5_2026-01-06_EN.pdf',
      'https://wiki.polymaker.com/polymaker-products/more-about-our-products/documents/technical-data-sheets/nylon/polymide-tm-copa',
      'https://wiki.polymaker.com/polymaker-products/polymaker-filaments/prime-materials/nylon-pa/polymide-tm-copa'
    ],
    source_labels: ['TDS PDF PolyMide CoPA V5.5', 'Wiki oficial — TDS CoPA', 'Wiki oficial — produto CoPA']
  }),
  Object.freeze({
    id: 'reinforced',
    brand_grade: 'Polymaker PolyMide™ PA6-CF',
    polymer_and_reinforcement: 'Nylon 6 (PA6) com 20% em massa de fibra de carbono picada, segundo a ficha oficial. Filamento abrasivo.',
    density_g_cm3: null,
    density_note: 'Densidade não informada na fonte consultada; não há massa estimada para este grade.',
    tensile_strength_mpa: 'não informado na fonte consultada',
    tensile_test_method_and_condition: 'não informado na fonte consultada',
    flexural_modulus_mpa: 'não informado na fonte consultada',
    thermal_property_and_test: 'A página oficial atribui ao PolyMide PA6-CF uma declaração de HDT de 215 °C, sem método/condição de ensaio. Outros dados térmicos não informados.',
    recommended_print_settings: 'Bico 280–300 °C; mesa 25–50 °C e câmara 25–50 °C (não exceder 50 °C); velocidade 60 mm/s; ventilador desligado; secagem 80 °C por 12 h se úmido; recozimento 80 °C por 6 h. Requer hotend totalmente metálico e bico resistente à abrasão. Baseado em bico 0,4 mm.',
    caveats: 'Não foram informados densidade, tração ou módulo flexural na ficha consultada. A página do produto atualmente redireciona para Fiberon PA6-CF20 e afirma ser a mesma fórmula do PolyMide predecessor; valores tabulados do grade Fiberon não foram transferidos. Apenas HDT de 215 °C é explicitamente atribuído à declaração textual PolyMide na página; método/condição ausente. PA6 higroscópico e abrasivo. Sem propriedades ausentes inferidas.',
    source_urls: [
      'https://polymaker.com/wp-content/tech-docs/PolyMide_PA6-CF_PIS_EN_V1.5.pdf',
      'https://polymaker.com/product/polymide-pa6-cf/'
    ],
    source_labels: ['Ficha oficial PolyMide PA6-CF V1.5', 'Página oficial do produto PolyMide PA6-CF']
  })
]);
