#!/usr/bin/env node
'use strict';

// Signs the dist/ directory using Samsung certificates from certs/ and creates StreamVault.wgt.
// Requires OpenSSL (available on the development host) instead of bundling vulnerable JS crypto parsers.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execSync } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_DIR, 'dist');
const CERT_DIR = path.join(PROJECT_DIR, 'certs');
const WGT_FILE = path.join(PROJECT_DIR, 'StreamVault.wgt');

const authorP12 = process.env.CERT_AUTHOR_P12 || path.join(CERT_DIR, 'author.p12');
const distributorP12 = process.env.CERT_DIST_P12 || path.join(CERT_DIR, 'distributor.p12');
const authorPassword = process.env.CERT_AUTHOR_PASSWORD;
const distributorPassword = process.env.CERT_DIST_PASSWORD;

for (const [name, value] of [
  ['CERT_AUTHOR_PASSWORD', authorPassword],
  ['CERT_DIST_PASSWORD', distributorPassword],
]) {
  if (!value) {
    console.error(`Error: ${name} env var is required. Add it to .env or export it.`);
    process.exit(1);
  }
}

for (const [label, file] of [
  ['author certificate', authorP12],
  ['distributor certificate', distributorP12],
]) {
  if (!fs.existsSync(file)) {
    console.error(`Error: ${label} not found at ${file}. Set CERT_AUTHOR_P12/CERT_DIST_P12 or place certificates in certs/.`);
    process.exit(1);
  }
}

function loadP12(p12Path, password) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-sign-'));
  const keyPath = path.join(tmpDir, 'key.pem');
  const certPath = path.join(tmpDir, 'certs.pem');
  try {
    // Pass the password via the environment, not argv (visible in ps).
    const opensslOptions = { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, STREAMVAULT_P12_PASS: password } };
    execFileSync('openssl', ['pkcs12', '-in', p12Path, '-passin', 'env:STREAMVAULT_P12_PASS', '-nocerts', '-nodes', '-out', keyPath], opensslOptions);
    execFileSync('openssl', ['pkcs12', '-in', p12Path, '-passin', 'env:STREAMVAULT_P12_PASS', '-nokeys', '-out', certPath], opensslOptions);
    const privateKeyPem = fs.readFileSync(keyPath, 'utf8');
    const certPem = fs.readFileSync(certPath, 'utf8');
    const certs = certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    if (!privateKeyPem.includes('PRIVATE KEY') || certs.length === 0) {
      throw new Error('Certificate bundle did not contain a private key and certificate');
    }
    return { privateKeyPem, certs };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('base64');
}

function getAllFiles(dir, base) {
  base = base || dir;
  let results = [];
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    if (entry === 'author-signature.xml' || entry === 'signature1.xml' || entry === 'signature2.xml') continue;
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results = results.concat(getAllFiles(full, base));
    } else {
      const rel = path.relative(base, full).replace(/\\/g, '/');
      results.push({ rel, full });
    }
  }
  return results.sort((a, b) => a.rel.localeCompare(b.rel));
}

function buildReferences(files, target) {
  let refs = '';
  for (const f of files) {
    const content = fs.readFileSync(f.full);
    const digest = sha256(content);
    const uri = encodeURIComponent(f.rel).replace(/%2F/g, '/');
    refs += `<Reference URI="${uri}">\n`;
    refs += `<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></DigestMethod>\n`;
    refs += `<DigestValue>${digest}</DigestValue>\n</Reference>\n`;
  }

  const objDigest = target === 'AuthorSignature'
    ? 'lpo8tUDs054eLlBQXiDPVDVKfw30ZZdtkRs1jd7H5K8='
    : 'u/jU3U4Zm5ihTMSjKGlGYbWzDfRkGphPPHx3gJIYEJ4=';

  refs += `<Reference URI="#prop">\n`;
  refs += `<Transforms>\n<Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"></Transform>\n</Transforms>\n`;
  refs += `<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></DigestMethod>\n`;
  refs += `<DigestValue>${objDigest}</DigestValue>\n</Reference>\n`;

  return refs;
}

function buildSignedInfo(target, refs) {
  return `<SignedInfo>\n` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod>\n` +
    `<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></SignatureMethod>\n` +
    refs +
    `</SignedInfo>\n`;
}

function canonicalize(signedInfoXml) {
  return signedInfoXml.replace('<SignedInfo>', '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">');
}

function signData(data, privateKeyPem) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(data);
  return signer.sign(privateKeyPem, 'base64');
}

function buildKeyInfo(certs) {
  let xml = '<KeyInfo><X509Data>\n';
  for (const cert of certs) {
    const b64 = cert
      .replace(/-----BEGIN CERTIFICATE-----\n?/, '')
      .replace(/-----END CERTIFICATE-----\n?/, '')
      .replace(/\r?\n/g, '');
    xml += `<X509Certificate>${b64}</X509Certificate>\n`;
  }
  xml += '</X509Data>\n</KeyInfo>\n';
  return xml;
}

function buildObject(target) {
  const role = target === 'AuthorSignature' ? 'author' : 'distributor';
  return `<Object Id="prop">` +
    `<SignatureProperties xmlns:dsp="http://www.w3.org/2009/xmldsig-properties">` +
    `<SignatureProperty Id="profile" Target="#${target}">` +
    `<dsp:Profile URI="http://www.w3.org/ns/widgets-digsig#profile"></dsp:Profile></SignatureProperty>` +
    `<SignatureProperty Id="role" Target="#${target}">` +
    `<dsp:Role URI="http://www.w3.org/ns/widgets-digsig#role-${role}"></dsp:Role></SignatureProperty>` +
    `<SignatureProperty Id="identifier" Target="#${target}">` +
    `<dsp:Identifier></dsp:Identifier></SignatureProperty>` +
    `</SignatureProperties></Object>`;
}

function createSignatureXML(target, filename, p12Path, password) {
  const { privateKeyPem, certs } = loadP12(p12Path, password);
  const files = getAllFiles(DIST_DIR);
  const refs = buildReferences(files, target);
  const signedInfo = buildSignedInfo(target, refs);
  const canonical = canonicalize(signedInfo);
  const signatureValue = signData(canonical, privateKeyPem);
  const keyInfo = buildKeyInfo(certs);
  const obj = buildObject(target);

  const xml = `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#" Id="${target}">\n` +
    signedInfo +
    `<SignatureValue>${signatureValue}</SignatureValue>` +
    keyInfo +
    obj +
    `\n</Signature>`;

  fs.writeFileSync(path.join(DIST_DIR, filename), xml);
  console.log(`Created ${filename}`);
}

console.log('Signing dist/ with author certificate...');
createSignatureXML('AuthorSignature', 'author-signature.xml', authorP12, authorPassword);

console.log('Signing dist/ with distributor certificate...');
createSignatureXML('DistributorSignature', 'signature1.xml', distributorP12, distributorPassword);

console.log('Creating WGT...');
if (fs.existsSync(WGT_FILE)) fs.unlinkSync(WGT_FILE);
execSync(`cd "${DIST_DIR}" && zip -r "${WGT_FILE}" . -x '*.map'`, { stdio: 'inherit' });

for (const f of ['author-signature.xml', 'signature1.xml', 'signature2.xml']) {
  const p = path.join(DIST_DIR, f);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

console.log(`\nSigned WGT: ${WGT_FILE}`);
