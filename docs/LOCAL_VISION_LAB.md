# Laboratório de Visão Computacional local

## Objetivo e privacidade

O painel **Laboratório de Visão Computacional** acrescenta um fluxo local de imagem sem alterar o modo facial de referência já existente. A imagem selecionada permanece na área de referência enquanto uma visualização separada mostra a reconstrução. O navegador envia a imagem apenas para `127.0.0.1` no próprio GRID SOUL; o servidor inicia `backend/vision/image_analyzer.py` como subprocesso local. Imagem, marcações e amostras não são enviadas ao ChatGPT, a uma API hospedada ou a um serviço externo.

O usuário controla explicitamente cada arquivo selecionado. Não há leitura automática de pastas ou câmeras. Uploads ficam limitados no front a 8 MiB e 40 megapixels; o servidor repete a validação, aceita somente PNG/JPEG/WEBP e reduz localmente a imagem a no máximo 2.048 px por lado e 4,2 MP para análise. A rotação permitida é 0°, 90°, 180° ou 270°. `data/vision-projects/` guarda projetos locais e é ignorado pelo Git. A API do laboratório tem limite local de 20 requisições por minuto.

## Preparação e execução

São necessários Node.js 20+, npm e Python 3. O laboratório usa NumPy, Pillow e OpenCV headless em ambiente virtual local. Na raiz do projeto:

```bash
npm ci
python3 -m venv .venv
.venv/bin/pip install -r requirements-vision.txt
npm start
```

Depois abra `http://127.0.0.1:8765/`, escolha **Abrir Laboratório de Visão Computacional** e carregue uma imagem. Se `.venv/bin/python` existir, o servidor o utiliza automaticamente; `GRID_SOUL_PYTHON` permite apontar para outro executável Python. Não exponha o servidor à rede pública. A API de visão e projetos rejeita hosts ou origens cruzadas e tem um limite próprio de requisições.

## Pipeline efetivamente implementado

1. **Decodificação:** respeita orientação EXIF, compõe transparência sobre `#020711`, confere dimensões/formato/tamanho e reduz uma cópia de processamento sem substituir o arquivo de referência do navegador.
2. **Cor:** agrupa cores no espaço CIELAB com k-means do OpenCV; oferece paletas de 8, 16, 32, 64 ou 128 cores e uma semente repetível. A reconstrução atribui a cada amostra a cor quantizada mais próxima, mantendo variedade quando a imagem contém variedade.
3. **Detalhe:** aplica Canny a uma imagem suavizada, extrai contornos e calcula brilho, saturação, contraste/desvio, gradiente e proporção de bordas. Um mapa de cores segmentadas também é produzido. Essas medidas são candidatas visuais, não identificação semântica de objetos.
4. **Marcações manuais:** uma camada transparente aceita pincel/linha, retângulo, círculo ou ponto; oferece desfazer/refazer, prioridade e exclusão. Destaques elevam a prioridade local; regiões pretas ignoram células. A marcação é enviada ao mesmo processo Python local.
5. **Amostragem e geometria:** cores são reamostradas por área para uma grade uniforme com a razão da imagem. A população, área declarada em milímetros, contagem de cores, rotação, peso dos contornos e semente entram no cálculo. As amostras são seis valores por cubo — `x_normalizado`, `y_normalizado`, `R`, `G`, `B` e prioridade. O navegador converte coordenadas para milímetros e monta cubos em `THREE.InstancedMesh`. O espaçamento e a altura visual são controles de exibição/saída.
6. **Inspeção/comparação:** original, contornos, segmentação e marcações têm camadas alternáveis; as camadas analíticas são devolvidas à orientação da imagem de referência, mesmo quando a rotação de construção é diferente. A comparação opcional calcula MAE, PSNR e SSIM entre a fonte (rotacionada quando solicitada) e o raster de cores quantizadas da própria grade. Essa medida exclui espaçamento entre cubos, profundidade, câmera, materiais e fidelidade 3D; não avalia fabricabilidade.

A área declarada mantém a proporção da imagem (`altura = largura × altura_px/largura_px`). A largura pode variar de 10 a 1.000.000 mm, portanto 200 m cabe como dimensão nominal. Isso não significa que uma grade de até 100.000 amostras tenha resolução de fabricação adequada: em áreas grandes, cada célula física também cresce. A interface mostra quando uma célula tem menos de 0,4 mm, mas o limite real depende de processo, bico, material e tolerâncias.

## Controles e saídas

- Resolução predefinida: 6.000, 24.000, 60.000 ou 100.000 amostras; também é possível digitar uma população entre 1.000 e 100.000.
- Paleta CIELAB; rotação; largura física em milímetros; peso de bordas; espaçamento entre cubos; altura visual em milímetros; semente.
- **PNG:** captura do canvas WebGL.
- **JSON da paleta:** cores predominantes e medidas de imagem.
- **JSON das coordenadas:** grade, parâmetros e amostras normalizadas/RGB/prioridade.
- **Projeto `.gridsoul.json`:** download portátil da imagem, marcações, dimensões, parâmetros e semente reproduzível. Um projeto é reanalisado localmente ao importar/reabrir para regenerar exatamente a mesma amostragem sem duplicar os arrays de coordenadas no arquivo de projeto.
- **Salvar projeto local:** grava no diretório local do servidor por arquivo JSON gzip, de maneira temporária/atômica e com permissão restrita; permite listar, abrir, atualizar, ajustar marcações, continuar após reiniciar o app e importar um projeto JSON baixado.
- **STL binário:** relevo/placa voxelizada 2.5D com coordenadas numéricas em milímetros. STL não transporta cores nem registra uma unidade de escala.
- **OBJ + MTL:** mesma superfície voxelizada, com materiais RGB para pré-visualização; mantenha os dois arquivos na mesma pasta. OBJ não garante metadados de unidade e a aceitação de MTL/cores varia entre CADs e slicers.

A exportação OBJ/MTL e STL aceita até 25.000 células por arquivo. Com espaço de 0%, a malha omite interfaces internas e forma uma placa de células vizinhas conectadas, fechando paredes de perímetro/áreas excluídas. Com espaço maior, cada microcubo se torna um sólido separado — o painel exibe aviso. Faces STL não guardam RGB. Uma impressão FDM comum tampouco converte automaticamente materiais MTL em impressão multicolorida.

## Limites e segurança de uso

Este fluxo entrega uma grade de cubos e um relevo 2.5D de uma única imagem, não um sistema CAD genérico nem uma cadeia de ferramentaria industrial. O mesh exporter não implementa STEP, 3MF, G-code/fatiamento, múltiplos corpos calibrados, suportes, FEM, tolerâncias, encaixes, retração, compensação térmica nem validação de impressora. Não existe envio direto para uma impressora na aplicação. Confira escala/unidades, seções, manifold e orientação no CAD/slicer do equipamento. Exportar um STL ou OBJ não é garantia de que o arquivo seja imprimível, seguro, dimensionalmente correto ou certificado.

Salvar e reabrir mantém o estado atual de uma imagem e seus dados para continuar esse projeto. Não há editor de mosaicos/blocos ou acumulação de mapas de terreno por dias/meses. A largura nominal de 200 m não cria, por si só, um mapa 3D geográfico/tesselado.

## Verificações

```bash
.venv/bin/python -m unittest discover -s test/vision -v
npm run check
```

Os testes Python usam imagens artificiais determinísticas e cobrem decodificação, cores, contornos, máscaras, proporção, amostragem e rotação. Os testes Node cobrem o serviço HTTP/local, os formatos mesh e o restante da aplicação. Eles não simulam todos os slicers ou impressoras e não certificam manufatura.
