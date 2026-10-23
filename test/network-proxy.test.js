import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createPinnedHttpsProxy } from '../lib/automation/network-proxy.js';

async function connectTunnel(proxyUrl, authority) {
  const endpoint = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(endpoint.port), endpoint.hostname);
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('proxy response timeout')); }, 2_000);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n\r\n')) {
        clearTimeout(timer);
        socket.destroy();
        resolve(buffer.split('\r\n', 1)[0]);
      }
    });
    socket.once('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
  });
}

test('proxy HTTPS nega domínios não concedidos antes da resolução DNS', async () => {
  const proxy = await createPinnedHttpsProxy(() => []);
  try {
    assert.match(await connectTunnel(proxy.url, 'example.com:443'), /^HTTP\/1\.1 403/);
  } finally { await proxy.close(); }
});

test('proxy HTTPS nega loopback mesmo quando um teste força a concessão literal', async () => {
  const proxy = await createPinnedHttpsProxy(() => ['https://127.0.0.1:8765']);
  try {
    assert.match(await connectTunnel(proxy.url, '127.0.0.1:8765'), /^HTTP\/1\.1 403/);
  } finally { await proxy.close(); }
});
