import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { isPublicAddress } from './policy.js';

const LOOPBACK = '127.0.0.1';
const CONNECT_TIMEOUT_MS = 10_000;
const DNS_TIMEOUT_MS = 5_000;

function reject(client, status, reason) {
  if (!client || client.destroyed) return;
  const body = `${reason}\n`;
  client.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

async function resolvePublicAddresses(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Destino local bloqueado.');
  }
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new Error('Endereço IP privado/reservado bloqueado.');
    return [{ address: host }];
  }
  let timer;
  let addresses;
  try {
    addresses = await Promise.race([
      dns.lookup(host, { all: true, verbatim: true }),
      new Promise((_, rejectPromise) => { timer = setTimeout(() => rejectPromise(new Error('Tempo esgotado validando DNS.')), DNS_TIMEOUT_MS); })
    ]);
  } finally { clearTimeout(timer); }
  if (!addresses.length || !addresses.every(item => isPublicAddress(item.address))) {
    throw new Error('O domínio resolve para endereço privado ou reservado.');
  }
  return addresses;
}

export async function createPinnedHttpsProxy(getAllowedOrigins) {
  const server = http.createServer((_request, response) => {
    response.writeHead(405, { Connection: 'close', 'Content-Length': '0' });
    response.end();
  });

  server.on('connect', (request, client, head) => {
    let upstream;
    let connected = false;
    client.on('error', () => upstream?.destroy());
    client.on('close', () => { if (connected) upstream?.destroy(); });
    void (async () => {
      try {
        const authority = new URL(`http://${request.url}`);
        if (authority.username || authority.password || !authority.hostname) throw new Error('CONNECT inválido.');
        const port = Number(authority.port || 443);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Porta inválida.');
        const origin = `https://${authority.hostname.toLowerCase()}${port === 443 ? '' : `:${port}`}`;
        if (!getAllowedOrigins().includes(origin)) throw new Error('Origem não concedida.');
        const addresses = await resolvePublicAddresses(authority.hostname);
        const selected = addresses[0].address;
        upstream = net.createConnection({ host: selected, port });
        await new Promise((resolve, rejectPromise) => {
          const timer = setTimeout(() => rejectPromise(new Error('Tempo esgotado ao conectar.')), CONNECT_TIMEOUT_MS);
          upstream.once('connect', () => { clearTimeout(timer); resolve(); });
          upstream.once('error', error => { clearTimeout(timer); rejectPromise(error); });
        });
        if (client.destroyed) return upstream.destroy();
        connected = true;
        client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: GRID-SOUL\r\n\r\n');
        if (head?.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      } catch {
        upstream?.destroy();
        reject(client, '403', 'Destino HTTPS bloqueado');
      }
    })();
  });
  server.on('clientError', (_error, socket) => reject(socket, '400', 'Solicitação inválida'));
  await new Promise((resolve, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, LOOPBACK, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise(resolve => server.close(() => resolve()));
    throw new Error('Não foi possível iniciar o proxy HTTPS local.');
  }
  return {
    url: `http://${LOOPBACK}:${address.port}`,
    close: () => new Promise(resolve => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections?.();
    })
  };
}
