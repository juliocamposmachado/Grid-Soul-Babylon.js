if (!globalThis.__GRID_SOUL_BRIDGE_CONTENT_LOADED__) {
let running = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalizeText = text => String(text || '').replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').trim();

async function waitForComposer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const composer = getComposer();
    if (composer) return composer;
    await sleep(300);
  }
  throw new Error('Campo de mensagem não apareceu. Entre na sua conta do ChatGPT, atualize a aba e repita a solicitação.');
}

function getComposer() {
  const selectors = [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    '[contenteditable="true"][role="textbox"]',
    'textarea[placeholder]',
    'textarea'
  ];
  for (const selector of selectors) {
    const candidates = [...document.querySelectorAll(selector)];
    const composer = candidates.find(element =>
      element.isConnected && !element.disabled && element.getAttribute('aria-hidden') !== 'true'
    );
    if (composer) return composer;
  }
  return null;
}

function getAssistantMessages() {
  const explicit = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  if (explicit.length) return explicit;

  const main = document.querySelector('main');
  if (!main) return [];
  const turns = [...main.querySelectorAll('[data-testid*="conversation-turn"]')]
    .filter(turn => {
      if (turn.querySelector('[data-message-author-role="user"]')) return false;
      const role = turn.getAttribute('data-role') || turn.getAttribute('data-message-author-role');
      if (role && !/assistant/i.test(role)) return false;
      return Boolean(turn.querySelector('.markdown, [class*="markdown"], button[aria-label*="copy" i], button[data-testid*="copy" i]'));
    });
  if (turns.length) return turns;

  const markdown = [...main.querySelectorAll('.markdown, [class*="markdown"]')];
  return markdown.filter(node =>
    node.innerText?.trim() && !node.querySelector('.markdown, [class*="markdown"]')
  );
}

function isEnabled(button) {
  return !button.disabled && button.getAttribute('aria-disabled') !== 'true';
}

function getSendButton(composer) {
  const form = composer.closest('form');
  const scopes = form ? [form] : [composer.parentElement, composer.parentElement?.parentElement, document].filter(Boolean);
  const selectors = [
    'button[data-testid="send-button"]',
    'button[data-testid*="send" i]',
    'button[data-testid*="submit" i]',
    'button[aria-label*="send" i]',
    'button[aria-label*="enviar" i]',
    'button[aria-label*="submit" i]',
    'button[aria-label*="mandar" i]',
    'button[type="submit"]'
  ];

  for (const scope of scopes) {
    for (const selector of selectors) {
      const button = [...scope.querySelectorAll(selector)].find(isEnabled);
      if (button) return button;
    }
  }
  return null;
}

async function waitForSendButton(composer, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const button = getSendButton(composer);
    if (button) return button;
    await sleep(150);
  }
  return null;
}

function isGenerating() {
  const selectors = 'button[data-testid="stop-button"], button[data-testid*="stop" i], button[aria-label*="stop" i], button[aria-label*="parar" i]';
  return [...document.querySelectorAll(selectors)].some(button => {
    if (!isEnabled(button) || button.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
      && rect.width > 0 && rect.height > 0;
  });
}

function setComposerValue(element, value) {
  element.focus();

  if (element.isContentEditable) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);

    let insertedNatively = false;
    try {
      insertedNatively = document.execCommand('insertText', false, value);
    } catch (_) {
      // Older or custom editors may not implement insertText; use the input-event fallback below.
    }

    const actualText = element.innerText ?? element.textContent ?? '';
    if (!insertedNatively || normalizeText(actualText) !== normalizeText(value)) {
      element.textContent = value;
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: value
      }));
    }
    return;
  }

  const setter = Object.getOwnPropertyDescriptor(
    element.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype,
    'value'
  )?.set;

  if (setter) setter.call(element, value);
  else element.value = value;

  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function handleTask(message) {
  if (running) return { error: 'Já existe um comando em andamento.' };
  running = true;

  try {
    const composer = await waitForComposer();

    const before = getAssistantMessages();
    const oldLast = before.length ? before[before.length - 1].innerText.trim() : '';

    const prompt = String(message.message || '');
    if (!prompt || prompt.length > 7000) throw new Error('Tarefa do servidor inválida ou longa demais.');

    setComposerValue(composer, prompt);
    const send = await waitForSendButton(composer);
    if (!send) {
      throw new Error('O texto foi colocado no ChatGPT, mas o botão Enviar não ficou ativo. Clique no campo de mensagem, confirme que o texto aparece e tente novamente.');
    }
    send.click();

    // Keep this below the server's 180 s task lease so a timeout is returned
    // to the bridge before the server expires the pending task.
    const deadline = Date.now() + 150000;
    let sawNewResponse = false;
    let stableText = '';
    let stableSince = Date.now();

    while (Date.now() < deadline) {
      await sleep(500);
      const messages = getAssistantMessages();
      const last = messages.length ? messages[messages.length - 1].innerText.trim() : '';
      if (normalizeText(last) === normalizeText(prompt)) continue;

      if (last && (last !== oldLast || messages.length > before.length)) {
        sawNewResponse = true;
        if (!isGenerating() && last === stableText) {
          if (Date.now() - stableSince > 1800) return { result: last };
        } else {
          stableText = last;
          stableSince = Date.now();
        }
      } else if (isGenerating()) {
        sawNewResponse = true;
      }

      if (sawNewResponse && !isGenerating() && stableText) {
        if (Date.now() - stableSince > 1800) return { result: stableText };
      }
    }

    if (stableText && Date.now() - stableSince >= 3500) {
      // A visible answer may be complete while ChatGPT keeps a stale stop
      // control mounted. Return the stable text; the server validates the JSON.
      return { result: stableText };
    }
    throw new Error('Tempo esgotado lendo a resposta do ChatGPT. Confira se ela apareceu completa na aba e tente novamente.');
  } catch (error) {
    return { error: String(error.message || error) };
  } finally {
    running = false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'GRID_SOUL_TASK') {
    handleTask(message).then(sendResponse);
    return true;
  }
});
globalThis.__GRID_SOUL_BRIDGE_CONTENT_LOADED__ = true;
}
