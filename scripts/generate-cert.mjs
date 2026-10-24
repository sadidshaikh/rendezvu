// Self-signed cert for localhost and this machine's LAN IPs, shared by the
// client dev server and the signaling server. Only for local development:
// in production the hosting platform terminates TLS.
//
// Usage: npm run certs [-- --force]

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const certDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../certs');
const certPath = path.join(certDir, 'cert.pem');
const keyPath = path.join(certDir, 'key.pem');

function lanIps() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface) => iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address);
}

if (!process.argv.includes('--force') && existsSync(certPath) && existsSync(keyPath)) {
  console.log(`Certificate already exists in ${certDir} (use --force to regenerate).`);
  process.exit(0);
}

const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanIps().map((ip) => `IP:${ip}`)].join(',');

mkdirSync(certDir, { recursive: true });
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyPath, '-out', certPath, '-days', '365',
  '-subj', '/CN=rendezvu-dev',
  '-addext', `subjectAltName=${san}`,
], { stdio: 'inherit' });

console.log(`Certificate written to ${certDir} for ${san}`);
