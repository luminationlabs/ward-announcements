/**
 * Whether a change to the people would leave the ward with no admin who can sign in.
 *
 * Stranding means: no owner password to fall back on, the person is an admin with a passkey, and no
 * *other* admin has one. On a hosted ward the owner password is usually off, so that would leave
 * nobody able to add people or change settings until the operator sent a new invite. A ward with an
 * owner password is never stranded: the owner can always sign in and add someone. `passkey` asks
 * about removing one passkey, which strands only when it is their last.
 */
export type AdminChange = 'demote' | 'remove' | 'passkey';

export function wouldStrandAdmins(
  people: { id: number; role: string; passkeys: number | string }[],
  id: number,
  change: AdminChange,
  ownerSignIn: boolean,
): boolean {
  if (ownerSignIn) return false;
  const person = people.find((p) => p.id === id);
  if (!person || person.role !== 'admin' || Number(person.passkeys) === 0) return false;
  if (change === 'passkey' && Number(person.passkeys) > 1) return false;
  return !people.some((p) => p.id !== id && p.role === 'admin' && Number(p.passkeys) > 0);
}
