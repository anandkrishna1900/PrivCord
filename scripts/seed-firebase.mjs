#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const ownerEmail = process.env.DUOCHAT_OWNER_EMAIL;
const peerEmail = process.env.DUOCHAT_PEER_EMAIL;
const conversationId = process.env.DUOCHAT_CONVERSATION_ID || 'duo';
const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (!ownerEmail || !peerEmail) {
  fail(
    [
      'Set both authorized account emails before seeding:',
      '',
      '  $env:DUOCHAT_OWNER_EMAIL="you@example.com"',
      '  $env:DUOCHAT_PEER_EMAIL="them@example.com"',
      '  $env:GOOGLE_APPLICATION_CREDENTIALS="C:\\path\\to\\service-account.json"',
      '  node scripts/seed-firebase.mjs',
      '',
      'Optionally set FIREBASE_PROJECT_ID and DUOCHAT_CONVERSATION_ID.',
    ].join('\n'),
  );
}

if (ownerEmail.trim().toLowerCase() === peerEmail.trim().toLowerCase()) {
  fail('The owner and peer emails must be different. DuoChat allows exactly two accounts.');
}

let credential;
let inferredProjectId;
try {
  if (serviceAccountPath) {
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
    credential = cert(serviceAccount);
    inferredProjectId = serviceAccount.project_id;
  } else {
    credential = applicationDefault();
  }
} catch (error) {
  fail(`Could not load Firebase credentials: ${error instanceof Error ? error.message : error}`);
}

const projectId = process.env.FIREBASE_PROJECT_ID || inferredProjectId;
if (!projectId) {
  fail(
    'Set FIREBASE_PROJECT_ID or point GOOGLE_APPLICATION_CREDENTIALS at a service-account JSON file.',
  );
}

const app =
  getApps()[0] ??
  initializeApp({
    credential,
    projectId,
  });

const auth = getAuth(app);
const db = getFirestore(app);

async function lookupAccount(email) {
  try {
    return await auth.getUserByEmail(email);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'auth/user-not-found') {
      fail(
        [
          `No Firebase Auth account exists for ${email}.`,
          'Create both accounts in Firebase Console > Authentication > Users, then rerun.',
          'Do not enable public sign-up for this private two-person deployment.',
        ].join('\n'),
      );
    }
    throw error;
  }
}

const [owner, peer] = await Promise.all([
  lookupAccount(ownerEmail.trim()),
  lookupAccount(peerEmail.trim()),
]);

if (owner.uid === peer.uid) {
  fail('Firebase returned the same UID for both emails. Refusing to seed.');
}

const memberIds = [owner.uid, peer.uid].sort();
const profileEntries = [
  [owner.uid, owner.displayName || ownerEmail.split('@')[0]],
  [peer.uid, peer.displayName || peerEmail.split('@')[0]],
];

await db.doc('config/access').set({
  memberIds,
  conversationId,
});

for (const [uid, displayName] of profileEntries) {
  const profile = db.doc(`users/${uid}`);
  const existing = await profile.get();
  if (existing.exists) {
    await profile.set({ displayName }, { merge: true });
  } else {
    await profile.set({
      displayName,
      createdAt: FieldValue.serverTimestamp(),
      lastSeenAt: FieldValue.serverTimestamp(),
    });
  }
}

await db.doc(`conversations/${conversationId}`).set(
  {
    memberIds,
    createdAt: FieldValue.serverTimestamp(),
    lastMessageAt: FieldValue.serverTimestamp(),
  },
  { merge: true },
);

console.log('DuoChat allowlist seeded.');
console.log(`  Project:      ${projectId}`);
console.log(`  Conversation: ${conversationId}`);
console.log(`  Members:      ${memberIds.join(', ')}`);
console.log('\nNext: firebase deploy --only firestore:rules,firestore:indexes');
console.log('Then sign in on both clients. Any other account is denied by rules.');
