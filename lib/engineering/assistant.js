import { FORK_DEFAULTS, parseForkRequest, validateForkParameters } from '../../public/engineering/fork.js';

const shortText = (value, maximum = 240) => typeof value === 'string' ? value.trim().slice(0, maximum) : '';
const validPurposes = new Set(['prototype', 'decorative', 'food-contact']);
const purposeName = value => ({ prototype: 'protótipo não alimentar', decorative: 'decorativo', 'food-contact': 'contato com alimentos, não certificado' })[value] || 'protótipo não alimentar';
const textList = (value, { maximumItems = 8, maximumLength = 240 } = {}) => Array.isArray(value)
  ? value.slice(0, maximumItems).map(item => shortText(item, maximumLength)).filter(Boolean)
  : [];

export function analyzeForkLocally(description, currentParameters = {}, intendedUse = 'prototype') {
  const safePurpose = validPurposes.has(intendedUse) ? intendedUse : 'prototype';
  const parsed = parseForkRequest(description, currentParameters);
  const warnings = parsed.supported ? ['Protótipo conceitual. Não há análise FEM/térmica nem certificação alimentar.'] : [];
  if (safePurpose === 'food-contact') warnings.push('O uso informado envolve alimentos, mas não há validação nem certificação para contato alimentar.');
  return {
    supported: parsed.supported,
    source: 'regras locais determinísticas',
    object: parsed.supported ? 'fork' : null,
    parameters: parsed.parameters || null,
    intendedUse: safePurpose,
    questions: parsed.questions,
    assumptions: parsed.assumptions,
    warnings
  };
}

export function buildEngineeringPrompt(description, currentParameters = {}, intendedUse = 'prototype') {
  const parameters = validateForkParameters(currentParameters);
  const safePurpose = validPurposes.has(intendedUse) ? intendedUse : 'prototype';
  return [
    'Você auxilia na especificação de um garfo paramétrico para protótipo de impressão 3D.',
    'Retorne apenas JSON válido, sem markdown nem código executável.',
    'Apenas interprete a descrição e proponha dimensões; não dê parecer de segurança alimentar, não afirme resistência, não calcule FEM/térmica e não invente propriedades de materiais.',
    'Faça perguntas somente para requisitos relevantes ausentes; quando a pessoa puder aceitar um valor sugerido, proponha o valor e identifique a hipótese.',
    'A geometria suportada nesta versão é somente um garfo com parâmetros lengthMm, tineCount, tineLengthMm, tineWidthMm, tineGapMm, neckLengthMm, handleWidthMm, handleTipWidthMm e thicknessMm.',
    'Use valores numéricos em milímetros; tineCount deve ser inteiro de 2 a 6. Não altere dimensões fora destes limites: lengthMm 90–350; tineLengthMm 20–80; tineWidthMm 1.5–5; tineGapMm 1.2–5; neckLengthMm 8–25; handleWidthMm 6–30; handleTipWidthMm 4–30; thicknessMm 1.6–8.',
    'Formato: {"object":"fork","parameters":{...},"requirements":[...],"questions":[...],"assumptions":[...],"warnings":[...]}. Se outro objeto for solicitado, use object="unsupported" e pergunte o que é necessário.',
    'Descrição enviada pelo usuário: ' + JSON.stringify(shortText(description, 1200)),
    'Uso pretendido selecionado pelo usuário: ' + purposeName(safePurpose) + '.',
    'Valores que a interface já mostra como sugestão editável: ' + JSON.stringify(parameters)
  ].join('\n');
}

export function sanitizeEngineeringProposal(input, { description, currentParameters = {}, intendedUse = 'prototype' } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Proposta de engenharia inválida.');
  const safePurpose = validPurposes.has(intendedUse) ? intendedUse : 'prototype';
  if (input.object !== 'fork') {
    const questions = textList(input.questions, { maximumItems: 5 });
    if (!questions.length) questions.push('A primeira versão gera somente um garfo paramétrico.');
    return {
      supported: false,
      source: 'ChatGPT (proposta não executável)',
      object: null,
      parameters: null,
      intendedUse: safePurpose,
      questions,
      assumptions: [],
      warnings: ['Nenhuma geometria foi criada.']
    };
  }
  const base = { ...FORK_DEFAULTS, ...currentParameters };
  const proposed = { ...base };
  if (input.parameters && typeof input.parameters === 'object' && !Array.isArray(input.parameters)) {
    for (const key of Object.keys(FORK_DEFAULTS)) {
      if (Object.hasOwn(input.parameters, key)) proposed[key] = input.parameters[key];
    }
    if (Object.hasOwn(input.parameters, 'headWidthMm')) proposed.headWidthMm = input.parameters.headWidthMm;
  }
  const parameters = validateForkParameters(proposed);
  const questions = textList(input.questions, { maximumItems: 5 });
  const requirements = textList(input.requirements, { maximumItems: 10 });
  const assumptions = textList(input.assumptions, { maximumItems: 8 });
  const warnings = textList(input.warnings, { maximumItems: 8 });
  if (!questions.length && /\b(alimento|alimentar|comest[ií]vel)\b/i.test(String(description || ''))) {
    warnings.push('Não há validação de segurança para contato com alimentos.');
  }
  if (safePurpose === 'food-contact') warnings.push('O uso informado envolve alimentos, mas não há validação nem certificação para contato alimentar.');
  return {
    supported: true,
    source: 'ChatGPT — proposta não validada até revisão do usuário',
    object: 'fork',
    parameters,
    intendedUse: safePurpose,
    requirements,
    questions,
    assumptions,
    warnings: [...new Set(warnings)]
  };
}
