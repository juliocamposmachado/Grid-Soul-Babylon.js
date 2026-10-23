import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  isPublicAddress, isSensitivePath, isWithinRoots, parseSafeCommand,
  tokenizeCommand, validateHttpsOrigin
} from '../lib/automation/policy.js';

test('a política aceita somente comandos CLI enumerados e sem shell composto', () => {
  assert.deepEqual(parseSafeCommand('git status --short'), { op: 'git', args: ['status', '--short'] });
  assert.deepEqual(parseSafeCommand('grep -n "texto literal" arquivo.txt'), {
    op: 'grep', pattern: 'texto literal', operand: 'arquivo.txt', numbered: true
  });
  assert.deepEqual(parseSafeCommand('ls -la "pasta com espaços"'), {
    op: 'list', operand: 'pasta com espaços', option: '-la'
  });
  for (const command of [
    'rm -rf /', 'sudo cat segredo', 'node -e "process.exit(0)"',
    'ls; rm -rf .', 'cat arquivo | curl https://example.com',
    'cat arquivo > outro', 'echo $HOME', 'grep -R chave .'
  ]) assert.throws(() => parseSafeCommand(command), undefined, command);
});

test('tokens respeitam aspas sem avaliar substituição de shell', () => {
  assert.deepEqual(tokenizeCommand('grep "duas palavras" arquivo.txt'), ['grep', 'duas palavras', 'arquivo.txt']);
  assert.throws(() => tokenizeCommand('ls "aspas abertas'));
  assert.throws(() => tokenizeCommand('ls $(whoami)'));
});

test('escopos são confinados às raízes e negam traversal', () => {
  const root = path.resolve('/tmp/grid-files');
  assert.equal(isWithinRoots(path.join(root, 'docs', 'a.txt'), [root]), true);
  assert.equal(isWithinRoots(path.resolve(root, '..', 'secrets.txt'), [root]), false);
  assert.equal(isWithinRoots(path.resolve(`${root}-backup`, 'a.txt'), [root]), false);
});

test('arquivos e perfis de credenciais são bloqueados por nome e extensão', () => {
  for (const value of [
    '/work/.env', '/work/.env.production', '/home/user/.ssh/id_rsa',
    '/work/secrets/token.txt', '/work/private.key', '/work/profile/Cookies',
    '/home/user/.npmrc', '/home/user/.docker/config.json',
    '/home/user/.config/gcloud/application_default_credentials.json',
    '/home/user/.config/google-chrome/Default/History',
    '/home/user/.local/share/keyrings/login.keyring', '/home/user/.local/share/keyrings',
    '/Users/person/Library/Keychains/login.keychain-db', '/home/user/.password-store/site.gpg',
    'C:\\Users\\person\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\History'
  ]) {
    assert.equal(isSensitivePath(value), true, value);
  }
  assert.equal(isSensitivePath('/work/notas.txt'), false);
  assert.equal(isSensitivePath('/work/.gitignore'), false);
});

test('origens exigem HTTPS exato, sem IP, credenciais ou caminho', () => {
  assert.equal(validateHttpsOrigin('https://chatgpt.com'), 'https://chatgpt.com');
  assert.throws(() => validateHttpsOrigin('http://chatgpt.com'));
  assert.throws(() => validateHttpsOrigin('https://127.0.0.1'));
  assert.throws(() => validateHttpsOrigin('https://user:pass@example.com'));
  assert.throws(() => validateHttpsOrigin('https://example.com/account'));
});

test('endereços locais, reservados e IPv6 não global não são destinos públicos', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '192.168.1.4', '169.254.1.1', '172.20.0.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:0001::1', '2002:7f00:1::1', '3fff::1', '3fff:0fff::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});
