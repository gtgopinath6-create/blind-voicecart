// Administrator account management through the Firebase Admin SDK, so creating a user
// never signs the administrator out (unlike the browser createUserWithEmailAndPassword).

const { HttpError } = require('./http');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function newProfile({ uid, email, name }) {
  return { uid, email, name, cart: [], wishlist: [], wallet: 0, purchaseHistory: [] };
}

async function createUser({ auth, db }, { name, email, password }) {
  const cleanName = typeof name === 'string' ? name.trim().slice(0, 80) : '';
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!cleanName) throw new HttpError(400, 'invalid_input', 'Enter a name.');
  if (!EMAIL_PATTERN.test(cleanEmail)) throw new HttpError(400, 'invalid_input', 'Enter a valid email address.');
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'invalid_input', 'The password must be at least 8 characters.');
  }

  let record;
  try {
    record = await auth.createUser({ email: cleanEmail, password, displayName: cleanName });
  } catch (e) {
    if (e.code === 'auth/email-already-exists') throw new HttpError(409, 'email_exists', 'An account with this email already exists.');
    if (e.code === 'auth/invalid-password') throw new HttpError(400, 'invalid_input', 'The password is too weak.');
    throw e;
  }
  try {
    await db.collection('users').doc(record.uid).set(newProfile({ uid: record.uid, email: cleanEmail, name: cleanName }));
  } catch (e) {
    // Do not leave a login without a profile behind.
    await auth.deleteUser(record.uid).catch(() => {});
    throw e;
  }
  return { uid: record.uid, email: cleanEmail, name: cleanName };
}

/** Blocks sign-in and ends existing sessions, keeping all data. Reversible. */
async function setUserDisabled({ auth }, { uid, disabled, callerUid }) {
  if (uid === callerUid) throw new HttpError(400, 'invalid_input', 'You cannot disable your own account.');
  await auth.updateUser(uid, { disabled: Boolean(disabled) });
  if (disabled) await auth.revokeRefreshTokens(uid);
  return { uid, disabled: Boolean(disabled) };
}

/**
 * Permanently deletes the login and the profile (cart, wishlist, wallet).
 * Orders and wallet transactions are kept for accounting, linked by uid.
 */
async function deleteUser({ auth, db }, { uid, callerUid }) {
  if (uid === callerUid) throw new HttpError(400, 'invalid_input', 'You cannot delete your own account.');
  try {
    await auth.deleteUser(uid);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }
  const profiles = await db.collection('users').where('uid', '==', uid).get();
  const batch = db.batch();
  profiles.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(db.collection('users').doc(uid));
  await batch.commit();
  return { uid, deleted: true };
}

module.exports = { createUser, setUserDisabled, deleteUser, newProfile };
