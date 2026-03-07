#!/usr/bin/env node
'use strict';

// Generates Samsung developer certificates for Tizen TV deployment.
// Requires env vars: SAMSUNG_ACCESS_TOKEN, SAMSUNG_USER_ID, TV_DUID

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const forge = require('node-forge');

const ACCESS_TOKEN = process.env.SAMSUNG_ACCESS_TOKEN;
const USER_ID = process.env.SAMSUNG_USER_ID;
const TV_DUID = process.env.TV_DUID;
const CERT_DIR = path.resolve(__dirname, '..', 'certs');
const CERT_PASSWORD = 'streamvault';

if (!ACCESS_TOKEN || !USER_ID || !TV_DUID) {
  console.error('Required env vars: SAMSUNG_ACCESS_TOKEN, SAMSUNG_USER_ID, TV_DUID');
  process.exit(1);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function postMultipart(host, urlPath, fields) {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');
    let body = '';

    for (const [key, val] of Object.entries(fields)) {
      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="${key}"`;
      if (key === 'csr') {
        body += `; filename="request.csr"\r\nContent-Type: application/octet-stream`;
      }
      body += `\r\n\r\n${val}\r\n`;
    }
    body += `--${boundary}--\r\n`;

    const options = {
      host,
      port: 443,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.toString()}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function generateAuthorCert() {
  console.log('Generating author key pair and CSR...');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: 'StreamVaultDeveloper' }]);
  csr.sign(keys.privateKey);

  const csrPem = forge.pki.certificationRequestToPem(csr);
  const priPem = forge.pki.privateKeyToPem(keys.privateKey);
  fs.writeFileSync(path.join(CERT_DIR, 'author.csr'), csrPem);
  fs.writeFileSync(path.join(CERT_DIR, 'author.pri'), priPem);

  console.log('Requesting author certificate from Samsung...');
  const crtData = await postMultipart('dev.tizen.samsung.com', '/apis/v2/authors', {
    access_token: ACCESS_TOKEN,
    user_id: USER_ID,
    platform: 'VD',
    csr: csrPem,
  });
  fs.writeFileSync(path.join(CERT_DIR, 'author.crt'), crtData);
  console.log('Author certificate received.');

  return { privateKey: keys.privateKey, crtData };
}

async function generateDistributorCert() {
  console.log('Generating distributor key pair and CSR...');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: 'TizenSDK' }]);
  csr.setAttributes([{
    name: 'extensionRequest',
    extensions: [{
      name: 'subjectAltName',
      altNames: [
        { type: 6, value: 'URN:tizen:packageid=' },
        { type: 6, value: `URN:tizen:deviceid=${TV_DUID}` },
      ],
    }],
  }]);
  csr.sign(keys.privateKey);

  const csrPem = forge.pki.certificationRequestToPem(csr);
  const priPem = forge.pki.privateKeyToPem(keys.privateKey);
  fs.writeFileSync(path.join(CERT_DIR, 'distributor.csr'), csrPem);
  fs.writeFileSync(path.join(CERT_DIR, 'distributor.pri'), priPem);

  console.log('Requesting distributor certificate from Samsung...');
  const crtData = await postMultipart('dev.tizen.samsung.com', '/apis/v2/distributors', {
    access_token: ACCESS_TOKEN,
    user_id: USER_ID,
    privilege_level: 'Public',
    developer_type: 'Individual',
    platform: 'VD',
    csr: csrPem,
  });
  fs.writeFileSync(path.join(CERT_DIR, 'distributor.crt'), crtData);
  console.log('Distributor certificate received.');

  return { privateKey: keys.privateKey, crtData };
}

function buildP12(name, privateKey, certData, caCertPem) {
  const certPem = certData.toString('utf8');
  const cert = forge.pki.certificateFromPem(certPem);
  const caCert = forge.pki.certificateFromPem(caCertPem);

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(
    privateKey, [cert, caCert], CERT_PASSWORD,
    { generateLocalKeyId: true, friendlyName: 'UserCertificate' }
  );
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
  fs.writeFileSync(path.join(CERT_DIR, `${name}.p12`), p12Der, { encoding: 'binary' });
  console.log(`${name}.p12 created.`);
}

async function main() {
  ensureDir(CERT_DIR);

  // Download Samsung CA certificates from the tizen-tv-dev-cli or tools package
  let samsungCertPath;
  try {
    const tools = require('@tizentv/tools');
    samsungCertPath = await tools.getSamsungCertPath();
  } catch {
    // Fallback: use certs from tizen-tv-dev-cli
    samsungCertPath = null;
  }

  const author = await generateAuthorCert();
  const distributor = await generateDistributorCert();

  // For the CA certs, we need them to build p12 files
  // If we can't get Samsung CA certs, just save the raw certs - they can still be used
  if (samsungCertPath) {
    const authorCaPem = fs.readFileSync(path.join(samsungCertPath, 'vd_tizen_dev_author_ca.cer'), 'utf8');
    const distCaPem = fs.readFileSync(path.join(samsungCertPath, 'vd_tizen_dev_public2.crt'), 'utf8');
    buildP12('author', author.privateKey, author.crtData, authorCaPem);
    buildP12('distributor', distributor.privateKey, distributor.crtData, distCaPem);
  } else {
    console.log('Samsung CA certs not available locally. Raw .crt and .pri files saved.');
    console.log('P12 files will be built during the GitHub Action with proper CA certs.');
  }

  console.log(`\nCertificates saved to ${CERT_DIR}/`);
}

main().catch(err => {
  console.error('Certificate generation failed:', err.message);
  process.exit(1);
});
