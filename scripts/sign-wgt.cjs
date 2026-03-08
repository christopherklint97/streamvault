#!/usr/bin/env node
'use strict';

// Signs the dist/ directory using Samsung certificates from certs/ and creates StreamVault.wgt
// Works with both Samsung certs (from generate-samsung-cert.cjs) and fallback dev certs

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');
const { execSync } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_DIR, 'dist');
const CERT_DIR = path.join(PROJECT_DIR, 'certs');
const WGT_FILE = path.join(PROJECT_DIR, 'StreamVault.wgt');
// Check if Samsung certs exist, otherwise fall back to tizen-tv-dev-cli
let authorP12, authorPassword, distributorP12, distributorPassword;

if (fs.existsSync(path.join(CERT_DIR, 'author.p12'))) {
  console.log('Using certificates from certs/');
  authorP12 = path.join(CERT_DIR, 'author.p12');
  authorPassword = process.env.CERT_AUTHOR_PASSWORD;
  distributorP12 = path.join(CERT_DIR, 'distributor.p12');
  distributorPassword = process.env.CERT_DIST_PASSWORD;
  if (!authorPassword || !distributorPassword) {
    console.error('Error: CERT_AUTHOR_PASSWORD and CERT_DIST_PASSWORD env vars required. Add them to .env.');
    process.exit(1);
  }
} else {
  console.log('Samsung certs not found, falling back to tizen-tv-dev-cli dev certs');
  const devCliPath = path.dirname(require.resolve('tizen-tv-dev-cli/package.json'));
  authorP12 = path.join(devCliPath, 'resource/Author/tizentvapp.p12');
  authorPassword = process.env.CERT_AUTHOR_PASSWORD;
  distributorP12 = path.join(devCliPath, 'resource/certificate-generator/certificates/distributor/tizen-distributor-signer.p12');
  distributorPassword = process.env.CERT_DIST_PASSWORD;
  if (!authorPassword || !distributorPassword) {
    console.error('Error: CERT_AUTHOR_PASSWORD and CERT_DIST_PASSWORD env vars required. Add them to .env.');
    process.exit(1);
  }
}

function loadP12(p12Path, password) {
  const p12Der = fs.readFileSync(p12Path, { encoding: 'binary' });
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

  let privateKey = null;
  const certs = [];

  const keyBags = p12.getBags({ bagType: forge.oids.pkcs8ShroudedKeyBag });
  for (const bagType of Object.keys(keyBags)) {
    for (const item of keyBags[bagType]) {
      if (item.key) privateKey = item.key;
    }
  }

  const certBags = p12.getBags({ bagType: forge.oids.certBag });
  for (const bagType of Object.keys(certBags)) {
    for (const item of certBags[bagType]) {
      if (item.cert) certs.push(item.cert);
    }
  }

  return { privateKey, certs };
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

  // Object reference
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
  // Wrap in Signature element for namespace, then extract canonical SignedInfo
  const wrapper = `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">${signedInfoXml}\n</Signature>`;
  // For exc-c14n#, the SignedInfo inherits the xmlns from parent
  // Simple approach: add the namespace to SignedInfo directly
  const canonical = signedInfoXml.replace('<SignedInfo>', '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">');
  return canonical;
}

function signData(data, privateKey) {
  const pem = forge.pki.privateKeyToPem(privateKey);
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(data);
  return signer.sign(pem, 'base64');
}

function buildKeyInfo(certs) {
  let xml = '<KeyInfo><X509Data>\n';
  for (const cert of certs) {
    const pem = forge.pki.certificateToPem(cert);
    const b64 = pem.replace(/-----BEGIN CERTIFICATE-----\n?/, '').replace(/-----END CERTIFICATE-----\n?/, '');
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
  const { privateKey, certs } = loadP12(p12Path, password);
  const files = getAllFiles(DIST_DIR);
  const refs = buildReferences(files, target);
  const signedInfo = buildSignedInfo(target, refs);
  const canonical = canonicalize(signedInfo);
  const signatureValue = signData(canonical, privateKey);
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

// Sign
console.log('Signing dist/ with author certificate...');
createSignatureXML('AuthorSignature', 'author-signature.xml', authorP12, authorPassword);

console.log('Signing dist/ with distributor certificate...');
createSignatureXML('DistributorSignature', 'signature1.xml', distributorP12, distributorPassword);

// Package
console.log('Creating WGT...');
if (fs.existsSync(WGT_FILE)) fs.unlinkSync(WGT_FILE);
execSync(`cd "${DIST_DIR}" && zip -r "${WGT_FILE}" . -x '*.map'`, { stdio: 'inherit' });

// Cleanup signature files from dist
for (const f of ['author-signature.xml', 'signature1.xml', 'signature2.xml']) {
  const p = path.join(DIST_DIR, f);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

console.log(`\nSigned WGT: ${WGT_FILE}`);
