// The SAS of every relay session this desktop has been on, keyed by the PEER's public key
// (security review, finding 3).
//
// A Hub-brokered session confirms the SAS automatically on both ends, so nobody looks at the
// 6-digit code the E2EE handshake produces. The code is derived from the STABLE ECDH key of the
// two long-lived identities (e2ee.ts `sasFromSharedKey` over the base key), so for a given pair
// of machines it is the SAME on both screens and the same on every session - unless a Hub handed
// one side a substituted key, in which case the two screens show DIFFERENT codes. Remembering
// each code here lets Settings > Team print it beside the member ("verify code"), so two people
// can compare it out of band ONCE and know their pinned keys are really each other's.
//
// Memory only: a code describes a live identity pair and is re-derived on every session, so
// there is nothing to persist. Both relay ends record here - the host from its accept path
// (hub-client.ts) and the guest from the relay client's SAS event (src/main/index.ts).

const codes = new Map<string, string>()
const listeners = new Set<() => void>()

export function rememberVerifyCode(peerPublicKeyB64: string, sas: string | null): void {
  if (!peerPublicKeyB64 || !sas) return
  if (codes.get(peerPublicKeyB64) === sas) return
  codes.set(peerPublicKeyB64, sas)
  for (const listener of listeners) listener()
}

/** Every remembered code, peer public key (base64) → "NNN NNN". */
export function verifyCodes(): Record<string, string> {
  return Object.fromEntries(codes)
}

export function onVerifyCodesChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function clearVerifyCodesForTests(): void {
  codes.clear()
  listeners.clear()
}
