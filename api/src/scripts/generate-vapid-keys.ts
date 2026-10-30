import webpush from "web-push";

/**
 * Creates a VAPID key pair for Web Push (T-403):  npm run vapid:generate
 * The PRIVATE key is a secret: put both keys in the server's environment (.env), never in the
 * repository, a chat or a log. Run this once; changing the keys later logs every browser out of
 * push (each one must subscribe again).
 */
const keys = webpush.generateVAPIDKeys();
console.log("Add these to the server environment (.env):\n");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log("VAPID_SUBJECT=mailto:you@your-domain.example   # change to a real contact address");
