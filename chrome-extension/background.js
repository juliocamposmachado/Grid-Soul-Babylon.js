const API = 'http://127.0.0.1:8765';
const CHATGPT_MATCHES = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
let polling = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isChatGPTUrl(url = '') {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)(\/|$)/i.test(url);
}

async function waitForTabLoad(tabId, timeoutMs = 30000) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === 'complete') return current;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      callback(value);
    };
    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish(resolve, tab);
    };
    const timer = setTimeout(() => finish(reject, new Error('Tempo esgotado carregando o ChatGPT.')), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') finish(resolve, tab);
    }).catch(error => finish(reject, error));
  });
}

async function getOrOpenChatGPTTab() {
  const tabs = await chrome.tabs.query({ url: CHATGPT_MATCHES });
  const existing = tabs.find(tab => tab.id);
  if (existing) return existing;

  const created = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: true });
  if (!created.id) throw new Error('O Chrome não retornou o ID da nova aba do ChatGPT.');
  return await waitForTabLoad(created.id);
}

async function sendTaskToChatGPT(tabId, task) {
  const deadline = Date.now() + 15000;
  let lastError;
  let injectionAttempted = false;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_) {
      return { error: 'A aba do ChatGPT foi fechada antes da resposta. Abra-a novamente e repita a solicitação.' };
    }
    if (!isChatGPTUrl(tab.url)) {
      return { error: 'O ChatGPT redirecionou para outra página. Entre na sua conta e envie a solicitação novamente.' };
    }
    try {
      return await chrome.tabs.sendMessage(tabId, {
        type: 'GRID_SOUL_TASK',
        id: task.id,
        message: task.message
      });
    } catch (error) {
      lastError = error;
      if (!injectionAttempted) {
        injectionAttempted = true;
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
          await sleep(250);
          continue;
        } catch (injectionError) {
          lastError = injectionError;
        }
      }
      await sleep(500);
    }
  }
  return { error: `Aba aberta, mas a extensão ainda não respondeu. Atualize o ChatGPT e tente novamente. ${lastError?.message || ''}`.trim() };
}

async function reportInstalledExtension() {
  const manifest = chrome.runtime.getManifest();
  const response = await fetch(`${API}/api/extension/heartbeat`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: chrome.runtime.id,
      version: manifest.version
    })
  });
  if (!response.ok) throw new Error(`heartbeat HTTP ${response.status}`);
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    try {
      await reportInstalledExtension();
    } catch (error) {
      console.warn('GRID SOUL extension heartbeat:', error.message);
    }
    const response = await fetch(`${API}/api/extension/next`, {
      cache: 'no-store'
    });
    if (!response.ok) return;

    const task = await response.json();
    if (!task?.id || !task?.message) return;

    const claim = await fetch(`${API}/api/extension/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: task.id })
    });
    if (!claim.ok) return;

    let result;
    try {
      const tab = await getOrOpenChatGPTTab();
      result = await sendTaskToChatGPT(tab.id, task);
    } catch (error) {
      result = { error: String(error.message || 'Não foi possível abrir o ChatGPT.').slice(0, 300) };
    }

    const resultResponse = await fetch(`${API}/api/extension/result`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: task.id,
        result: result?.result || '',
        error: result?.error || ''
      })
    });
    if (!resultResponse.ok) {
      console.warn('GRID SOUL task result rejected:', `HTTP ${resultResponse.status}`);
    }
  } catch (error) {
    console.warn('GRID SOUL poll:', error.message);
  } finally {
    polling = false;
  }
}

chrome.alarms.create('gridsoul-poll', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'gridsoul-poll') poll();
});
chrome.runtime.onStartup.addListener(poll);
chrome.runtime.onInstalled.addListener(poll);
poll();
