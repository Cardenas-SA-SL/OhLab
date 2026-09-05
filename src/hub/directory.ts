import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import nacl from 'tweetnacl'
import { WebSocket } from 'ws'
import { writeFileAtomic } from '../core/fs-atomic'
import { DEFAULT_HUB_LIMITS, HubLimitError, type HubLimits } from './limits'

export interface Account {
  accountId: string
  name: string
  publicKeyB64: string
  createdAt: number
  machineLabel?: string
}

export type ProjectMember = {
  accountId: string
  role: 'owner' | 'member'
  status: 'pending' | 'approved'
  joinedAt: number
  /** The member's app has bound a local project as its side of this shared project, so there is
   *  an agent canvas for the other members to open. Reported by the member itself; absent = no. */
  sharing?: boolean
}

export interface SharedProject {
  projectId: string
  name: string
  ownerAccountId: string
  members: ProjectMember[]
  inviteCode: string
  createdAt: number
}

export type DirectoryEvent =
  | { type: 'member-joined'; projectId: string; accountId: string }
  | { type: 'member-approved'; projectId: string; accountId: string }
  | { type: 'member-declined'; projectId: string; accountId: string }
  | { type: 'member-online' | 'member-offline'; accountId: string }
  | { type: 'member-sharing'; projectId: string; accountId: string; sharing: boolean }
  | {
      type: 'session-request'
      projectId: string
      fromAccountId: string
      fromPublicKeyB64: string
      pairingToken: string
      relayUrl: string
      machineLabel: string
    }

/** What the Hub knows about ONE directory socket: the relay URL as seen from that socket's own
 *  side. Every member dials the Hub through its own address (loopback on the machine that embeds
 *  it, a LAN or Tailscale IP from elsewhere), so a session brokered to a member must advertise the
 *  relay through the authority THAT member reached the Hub on, never the one the caller used. */
export interface DirectoryLink {
  relayUrl: string
}

interface DirectoryFile {
  accounts: Account[]
  projects: SharedProject[]
}

interface Challenge {
  challengeB64: string
  publicKeyB64: string
  exp: number
  /** The client address it was issued to, for the per-address ceiling. */
  issuer?: string
}

type DirectoryLimits = Pick<HubLimits, 'maxChallenges' | 'maxChallengesPerIssuer' | 'maxSessionsPerAccount' | 'maxAccounts' | 'maxProjects' | 'maxProjectsPerAccount'>

const SESSION_TTL_MS = 60 * 60 * 1000
const CHALLENGE_TTL_MS = 2 * 60 * 1000

function opaque(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

function validPublicKey(value: string): Uint8Array | null {
  try {
    const key = Uint8Array.from(Buffer.from(value, 'base64'))
    return key.length === nacl.box.publicKeyLength ? key : null
  } catch {
    return null
  }
}

export class HubDirectory {
  private readonly file: string
  private accounts = new Map<string, Account>()
  private projects = new Map<string, SharedProject>()
  private challenges = new Map<string, Challenge>()
  private sessions = new Map<string, { accountId: string; exp: number }>()
  private sockets = new Map<string, Map<WebSocket, DirectoryLink>>()
  private saveTail: Promise<void> = Promise.resolve()

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
    private readonly limits: DirectoryLimits = DEFAULT_HUB_LIMITS
  ) {
    this.file = path.join(dataDir, 'directory.json')
  }

  async init(): Promise<void> {
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8')) as DirectoryFile
      for (const account of value.accounts ?? []) this.accounts.set(account.accountId, account)
      for (const project of value.projects ?? []) this.projects.set(project.projectId, project)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  issueChallenge(publicKeyB64: string, issuer?: string): {
    challengeId: string
    hubPublicKeyB64: string
    nonceB64: string
    boxB64: string
    exp: number
  } {
    const publicKey = validPublicKey(publicKeyB64)
    if (!publicKey) throw new Error('invalid publicKeyB64')
    // Ceilings before the key pair: an unanswered challenge used to live forever, and every one
    // costs a fresh box key pair, so an unauthenticated loop was both a memory and a CPU sink.
    const live = this.pruneChallenges(issuer)
    if (live.total >= this.limits.maxChallenges) throw new HubLimitError('the Hub has too many open key challenges')
    if (issuer && live.mine >= this.limits.maxChallengesPerIssuer) throw new HubLimitError('too many open key challenges from this address')
    const hubKeys = nacl.box.keyPair()
    const nonce = nacl.randomBytes(nacl.box.nonceLength)
    const challenge = randomBytes(32)
    const boxed = nacl.box(challenge, nonce, publicKey, hubKeys.secretKey)
    const challengeId = randomUUID()
    const exp = this.now() + CHALLENGE_TTL_MS
    this.challenges.set(challengeId, {
      challengeB64: challenge.toString('base64'),
      publicKeyB64,
      exp,
      ...(issuer ? { issuer } : {})
    })
    return {
      challengeId,
      hubPublicKeyB64: Buffer.from(hubKeys.publicKey).toString('base64'),
      nonceB64: Buffer.from(nonce).toString('base64'),
      boxB64: Buffer.from(boxed).toString('base64'),
      exp
    }
  }

  async authenticate(input: {
    name?: string
    publicKeyB64: string
    challengeId: string
    proofB64: string
    machineLabel?: string
  }): Promise<{ account: Account; sessionToken: string; exp: number }> {
    const challenge = this.challenges.get(input.challengeId)
    this.challenges.delete(input.challengeId)
    if (
      !challenge ||
      challenge.exp <= this.now() ||
      challenge.publicKeyB64 !== input.publicKeyB64 ||
      challenge.challengeB64 !== input.proofB64
    ) {
      throw new Error('invalid or expired challenge proof')
    }
    const name = input.name?.trim()
    const machineLabel = input.machineLabel?.trim().slice(0, 80)
    let account = [...this.accounts.values()].find((item) => item.publicKeyB64 === input.publicKeyB64)
    if (!account) {
      if (!name) throw new Error('name is required for registration')
      if (this.accounts.size >= this.limits.maxAccounts) throw new HubLimitError('the Hub has reached its account limit')
      account = { accountId: randomUUID(), name, publicKeyB64: input.publicKeyB64, createdAt: this.now(), machineLabel }
      this.accounts.set(account.accountId, account)
      await this.save()
    } else {
      let changed = false
      if (name && account.name !== name) {
        account.name = name
        changed = true
      }
      if (machineLabel && account.machineLabel !== machineLabel) {
        account.machineLabel = machineLabel
        changed = true
      }
      if (changed) await this.save()
    }
    const sessionToken = opaque()
    const exp = this.now() + SESSION_TTL_MS
    this.sessions.set(sessionToken, { accountId: account.accountId, exp })
    this.evictSurplusSessions(account.accountId)
    return { account, sessionToken, exp }
  }

  /** One account holds at most `maxSessionsPerAccount` live sessions; the oldest go first. A
   *  desktop holds one (it re-proves its key only on restart or a 401), so an account past the
   *  ceiling is a loop minting sessions, and evicting its oldest costs it nothing it needs. */
  private evictSurplusSessions(accountId: string): void {
    const at = this.now()
    const mine: string[] = []
    for (const [token, session] of this.sessions) {
      if (session.exp <= at) {
        this.sessions.delete(token)
        continue
      }
      if (session.accountId === accountId) mine.push(token)
    }
    // Map iteration is insertion order, so the front of `mine` is the oldest session.
    for (const token of mine.slice(0, Math.max(0, mine.length - this.limits.maxSessionsPerAccount))) {
      this.sessions.delete(token)
    }
  }

  accountForSession(token: string): Account | null {
    const session = this.sessions.get(token)
    if (!session || session.exp <= this.now()) {
      if (session) this.sessions.delete(token)
      return null
    }
    return this.accounts.get(session.accountId) ?? null
  }

  async createProject(accountId: string, name: string, projectId?: string): Promise<SharedProject> {
    const id = projectId?.trim() || randomUUID()
    if (this.projects.has(id)) throw new Error('project already exists')
    if (this.projects.size >= this.limits.maxProjects) throw new HubLimitError('the Hub has reached its project limit')
    let owned = 0
    for (const project of this.projects.values()) if (project.ownerAccountId === accountId) owned++
    if (owned >= this.limits.maxProjectsPerAccount) throw new HubLimitError('this account has reached its project limit')
    const project: SharedProject = {
      projectId: id,
      name: name.trim() || 'Shared project',
      ownerAccountId: accountId,
      members: [{ accountId, role: 'owner', status: 'approved', joinedAt: this.now() }],
      inviteCode: opaque(12),
      createdAt: this.now()
    }
    this.projects.set(project.projectId, project)
    await this.save()
    return project
  }

  listProjects(accountId: string): SharedProject[] {
    return [...this.projects.values()].filter((project) => project.members.some((m) => m.accountId === accountId))
  }

  projectForMember(projectId: string, accountId: string): SharedProject | null {
    const project = this.projects.get(projectId)
    return project?.members.some((member) => member.accountId === accountId) ? project : null
  }

  async regenerateInvite(projectId: string, ownerId: string): Promise<SharedProject> {
    const project = this.requireOwner(projectId, ownerId)
    project.inviteCode = opaque(12)
    await this.save()
    return project
  }

  async join(accountId: string, inviteCode: string): Promise<SharedProject> {
    const project = [...this.projects.values()].find((item) => item.inviteCode === inviteCode)
    if (!project) throw new Error('invite code not found')
    const existing = project.members.find((member) => member.accountId === accountId)
    if (!existing) {
      project.members.push({ accountId, role: 'member', status: 'pending', joinedAt: this.now() })
      await this.save()
      this.pushProject(project, { type: 'member-joined', projectId: project.projectId, accountId })
    }
    return project
  }

  async approve(projectId: string, ownerId: string, accountId: string): Promise<SharedProject> {
    const project = this.requireOwner(projectId, ownerId)
    const member = project.members.find((item) => item.accountId === accountId && item.role !== 'owner')
    if (!member) throw new Error('member not found')
    member.status = 'approved'
    await this.save()
    this.pushProject(project, { type: 'member-approved', projectId, accountId })
    if (this.isOnline(accountId)) this.broadcastPresence(accountId, 'member-online')
    return project
  }

  async removeMember(projectId: string, ownerId: string, accountId: string): Promise<SharedProject> {
    const project = this.requireOwner(projectId, ownerId)
    if (accountId === ownerId) throw new Error('the project owner cannot be removed')
    const removed = project.members.find((item) => item.accountId === accountId)
    project.members = project.members.filter((item) => item.accountId !== accountId)
    await this.save()
    if (removed?.status === 'pending') this.push(accountId, { type: 'member-declined', projectId, accountId })
    return project
  }

  members(projectId: string, accountId: string): Array<ProjectMember & { name: string; publicKeyB64: string; online: boolean; machineLabel?: string; sharing: boolean }> {
    const project = this.projectForMember(projectId, accountId)
    if (!project) throw new Error('project not found')
    return project.members.flatMap((member) => {
      const account = this.accounts.get(member.accountId)
      return account ? [{ ...member, name: account.name, publicKeyB64: account.publicKeyB64, online: this.isOnline(account.accountId), machineLabel: account.machineLabel, sharing: member.sharing === true }] : []
    })
  }

  /**
   * A member says whether its app has a local side for this project. Any member (pending ones
   * included — a guest binds at join time, before approval) may set its OWN flag and nobody
   * else's. Approved members are told, because that flag is what their auto-connect decides on.
   */
  async setSharing(projectId: string, accountId: string, sharing: boolean): Promise<SharedProject> {
    const project = this.projectForMember(projectId, accountId)
    const member = project?.members.find((item) => item.accountId === accountId)
    if (!project || !member) throw new Error('project not found')
    if ((member.sharing === true) !== sharing) {
      if (sharing) member.sharing = true
      else delete member.sharing
      await this.save()
      this.pushProject(project, { type: 'member-sharing', projectId, accountId, sharing })
    }
    return project
  }

  approvedPeers(projectId: string, fromId: string, toId: string): { project: SharedProject; from: Account; to: Account } {
    const project = this.projects.get(projectId)
    const approved = (id: string): boolean => project?.members.some((m) => m.accountId === id && m.status === 'approved') ?? false
    const from = this.accounts.get(fromId)
    const to = this.accounts.get(toId)
    if (!project || !from || !to || !approved(fromId) || !approved(toId)) throw new Error('both accounts must be approved project members')
    return { project, from, to }
  }

  attach(accountId: string, ws: WebSocket, link: DirectoryLink): void {
    const wasOnline = this.isOnline(accountId)
    const links = this.sockets.get(accountId) ?? new Map<WebSocket, DirectoryLink>()
    links.set(ws, link)
    this.sockets.set(accountId, links)
    if (!wasOnline) this.broadcastPresence(accountId, 'member-online')
    ws.on('close', () => {
      links.delete(ws)
      if (links.size === 0) {
        this.sockets.delete(accountId)
        this.broadcastPresence(accountId, 'member-offline')
      }
    })
  }

  /** Deliver an event to every open socket of an account. Pass a function to shape the event per
   *  socket (a `session-request` carries the relay URL reachable from THAT socket's side). */
  push(accountId: string, event: DirectoryEvent | ((link: DirectoryLink) => DirectoryEvent)): boolean {
    let delivered = false
    for (const [ws, link] of this.sockets.get(accountId) ?? []) {
      if (ws.readyState !== WebSocket.OPEN) continue
      ws.send(JSON.stringify(typeof event === 'function' ? event(link) : event))
      delivered = true
    }
    return delivered
  }

  isOnline(accountId: string): boolean {
    return (this.sockets.get(accountId)?.size ?? 0) > 0
  }

  adminAccounts(): Account[] {
    return [...this.accounts.values()]
  }

  adminProjects(): SharedProject[] {
    return [...this.projects.values()]
  }

  async deleteAccount(accountId: string): Promise<void> {
    this.accounts.delete(accountId)
    for (const [id, project] of this.projects) {
      if (project.ownerAccountId === accountId) this.projects.delete(id)
      else project.members = project.members.filter((member) => member.accountId !== accountId)
    }
    for (const ws of this.sockets.get(accountId)?.keys() ?? []) ws.close(4401, 'account deleted')
    this.sockets.delete(accountId)
    await this.save()
  }

  async deleteProject(projectId: string): Promise<void> {
    this.projects.delete(projectId)
    await this.save()
  }

  /** Raw row counts, expired rows included (nothing is pruned on the way). */
  size(): { accounts: number; projects: number; challenges: number; sessions: number } {
    return { accounts: this.accounts.size, projects: this.projects.size, challenges: this.challenges.size, sessions: this.sessions.size }
  }

  /** Live (unexpired) challenges right now, overall and for one issuing address. */
  liveChallengeCount(issuer?: string): { total: number; issuer: number } {
    const live = this.pruneChallenges(issuer)
    return { total: live.total, issuer: live.mine }
  }

  /** Live (unexpired) sessions right now. */
  liveSessionCount(): number {
    const at = this.now()
    for (const [token, session] of this.sessions) if (session.exp <= at) this.sessions.delete(token)
    return this.sessions.size
  }

  /** Drop expired challenges and sessions. Both are memory-only, so nothing is written; before the
   *  Hub's periodic sweep an unanswered challenge and a session nobody presented again lived until
   *  the process did. Returns what was dropped. */
  sweep(): { challenges: number; sessions: number } {
    const challenges = this.challenges.size
    const sessions = this.sessions.size
    this.pruneChallenges()
    this.liveSessionCount()
    return { challenges: challenges - this.challenges.size, sessions: sessions - this.sessions.size }
  }

  private pruneChallenges(issuer?: string): { total: number; mine: number } {
    const at = this.now()
    let total = 0
    let mine = 0
    for (const [id, challenge] of this.challenges) {
      if (challenge.exp <= at) {
        this.challenges.delete(id)
        continue
      }
      total++
      if (issuer && challenge.issuer === issuer) mine++
    }
    return { total, mine }
  }

  private requireOwner(projectId: string, accountId: string): SharedProject {
    const project = this.projects.get(projectId)
    if (!project || project.ownerAccountId !== accountId) throw new Error('project owner required')
    return project
  }

  private broadcastPresence(accountId: string, type: 'member-online' | 'member-offline'): void {
    const recipients = new Set<string>()
    for (const project of this.projects.values()) {
      if (!project.members.some((member) => member.accountId === accountId && member.status === 'approved')) continue
      for (const member of project.members) if (member.status === 'approved' && member.accountId !== accountId) recipients.add(member.accountId)
    }
    for (const recipient of recipients) this.push(recipient, { type, accountId })
  }

  private pushProject(project: SharedProject, event: DirectoryEvent): void {
    for (const member of project.members) {
      if (member.status === 'approved') this.push(member.accountId, event)
    }
  }

  private save(): Promise<void> {
    this.saveTail = this.saveTail.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const value: DirectoryFile = { accounts: [...this.accounts.values()], projects: [...this.projects.values()] }
      await writeFileAtomic(this.file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    })
    return this.saveTail
  }
}
