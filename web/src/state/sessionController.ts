import type {
  AgentsResponse,
  CreateSessionRequest,
  ModelsResponse,
  MessageAttachment,
  PromptContentBlock,
  SessionDetail,
  SessionListResponse,
} from '@casper/shared';
import { stripAttachmentsLine, titleFromPrompt } from '@casper/shared';
import { api } from '../api/rest.js';
import { SessionSocket, type SessionSocketHandlers } from '../api/SessionSocket.js';
import { DRAFT_PATH, pathForSession } from '../util/route.js';
import { useStore } from './store.js';

/**
 * Everything that happens to a session between a click and the screen: opening
 * one, creating one, sending to it, deleting it, and tearing the socket down.
 *
 * Deliberately not a component or a hook. React owns rendering and routing; this
 * owns coordination, which is what makes it reachable from a test - a hook would
 * need a renderer, and inside a component none of this could be called at all.
 */

export type CreateOpts = Omit<CreateSessionRequest, 'freshWorkspace'>;

/** The REST calls a session's lifecycle needs. `api` satisfies it. */
export interface SessionApi {
  listSessions(): Promise<SessionListResponse>;
  getSession(id: string): Promise<SessionDetail>;
  createSession(req: CreateSessionRequest): Promise<SessionDetail>;
  deleteSession(id: string): Promise<unknown>;
  renameSession(id: string, title: string): Promise<unknown>;
  reloadSession(id: string): Promise<SessionDetail>;
  models(): Promise<ModelsResponse>;
  agents(): Promise<AgentsResponse>;
}

/** The socket surface the controller drives. SessionSocket satisfies it. */
export interface ControlledSocket {
  connect(): void;
  close(): void;
  reset(head: number): void;
  prompt(content: PromptContentBlock[], attachments?: MessageAttachment[]): boolean;
  cancel(): void;
  setMode(modeId: string): void;
  setModel(modelId: string): void;
  watchPaths(paths: string[]): void;
  execCommand(command: string, args?: string): void;
}

export type CreateSocket = (
  sessionId: string,
  handlers: SessionSocketHandlers,
  startCursor: number,
) => ControlledSocket;

/** What only React can do: change the URL, and send the user back to the gate. */
export interface ControllerHost {
  navigate: (path: string, opts?: { replace?: boolean }) => void;
  onLock: () => void;
}

export interface ControllerOptions {
  api?: SessionApi;
  createSocket?: CreateSocket;
  /** Clustered list refreshes collapse into one request within this window. */
  listCoalesceMs?: number;
  /** kiro persists a session shortly after a turn ends; wait, then reconcile. */
  turnEndedRefreshMs?: number;
  /** If a compact command never lands, don't leave the UI stuck compacting. */
  compactTimeoutMs?: number;
}

// Human names for the control actions the server acks, so a rejection reads as
// "Model change failed: ..." rather than leaking the wire action name.
const ACTION_LABEL: Record<string, string> = {
  prompt: 'Message',
  cancel: 'Stop',
  set_mode: 'Agent change',
  set_model: 'Model change',
  exec_command: 'Command',
};

export class SessionController {
  private readonly api: SessionApi;
  private readonly createSocket: CreateSocket;
  private readonly listCoalesceMs: number;
  private readonly turnEndedRefreshMs: number;
  private readonly compactTimeoutMs: number;

  private host: ControllerHost | null = null;
  private socket: ControlledSocket | null = null;
  /** The session an open is currently racing toward, so a stale fetch is dropped. */
  private openTarget: string | null = null;
  /** The route already acted on, so a claim survives the navigation landing. */
  private handledRoute: string | null | undefined = undefined;
  private isDraft = false;
  private lastSent: string | null = null;
  private msgSeq = 0;
  /** A draft's first prompt, held until the new session's socket is connected. */
  private firstPrompt: {
    id: string;
    content: PromptContentBlock[];
    attachments?: MessageAttachment[];
  } | null = null;
  /** What the last create asked for, so the error screen's Retry can repeat it. */
  private lastCreateOpts: CreateOpts | null = null;
  private listSeq = 0;
  private listTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ControllerOptions = {}) {
    this.api = opts.api ?? api;
    this.createSocket =
      opts.createSocket ?? ((id, handlers, cursor) => new SessionSocket(id, handlers, cursor));
    this.listCoalesceMs = opts.listCoalesceMs ?? 150;
    this.turnEndedRefreshMs = opts.turnEndedRefreshMs ?? 1200;
    this.compactTimeoutMs = opts.compactTimeoutMs ?? 120_000;
  }

  /** The Shell hands over the two things only React can do. */
  attach(host: ControllerHost): void {
    this.host = host;
  }

  private get state() {
    return useStore.getState();
  }

  // -------------------------------------------------------------------------
  // Session list
  // -------------------------------------------------------------------------

  /**
   * Refreshes cluster - boot, route changes, a turn starting or ending, a reconnect
   * replaying events - so calls within a short window collapse into one request, and
   * only the newest reply is applied: a late answer from before a session was named
   * would undo its title.
   */
  refreshSessions(): void {
    if (this.listTimer !== null) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      const seq = ++this.listSeq;
      this.api
        .listSessions()
        .then((r) => {
          if (seq === this.listSeq) this.state.setSessions(r.sessions);
        })
        .catch(() => {});
    }, this.listCoalesceMs);
  }

  /** Models and agents for the pickers. Quiet on failure: an empty picker is its own signal. */
  loadPickers(): void {
    void this.api
      .models()
      .then((r) => this.state.setModels(r.models))
      .catch(() => {});
    void this.api
      .agents()
      .then((r) => this.state.setAgents(r.agents, r.defaultAgentId))
      .catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Opening
  // -------------------------------------------------------------------------

  /**
   * The route owns which session is open, so cold loads, back/forward and clicks all
   * arrive here. Acts on a change of route rather than on every render.
   */
  syncRoute(routeSessionId: string | null, isDraft: boolean): void {
    this.isDraft = isDraft;
    if (this.handledRoute === routeSessionId) return;
    this.handledRoute = routeSessionId;
    if (routeSessionId) {
      void this.openSession(routeSessionId);
    } else {
      this.openTarget = null;
      this.closeSocket();
      this.state.clearActive();
      this.refreshSessions();
    }
  }

  closeSocket(): void {
    this.socket?.close();
    this.socket = null;
  }

  /**
   * `adopted` is a detail already in hand, from creating the session: there is nothing
   * to fetch, and no "Opening session" state to show, which is what made the draft
   * look like it reloaded the page.
   */
  async openSession(id: string, adopted?: SessionDetail): Promise<void> {
    if (this.state.activeId === id) return;
    this.openTarget = id;
    this.closeSocket();
    this.state.setConnStatus('connecting');
    if (!adopted) this.state.setLoadingSession(id);

    let detail: SessionDetail;
    if (adopted) {
      detail = adopted;
    } else {
      try {
        detail = await this.api.getSession(id);
      } catch (err) {
        if (this.openTarget !== id) return;
        // Fetch failed (network, or the session was deleted): don't strand the
        // UI in "connecting" - reset and surface the error.
        this.state.setConnStatus('closed');
        this.state.setLoadingSession(null);
        console.error('open session failed:', err);
        // Replaced, so a refresh doesn't retry it and back doesn't return to it.
        this.host?.navigate('/', { replace: true });
        return;
      }
    }
    // Abandoned while fetching: leave whatever the user moved on to alone.
    if (this.openTarget !== id) return;
    this.state.loadDetail(detail, { keepPending: Boolean(adopted) });

    this.socket = this.createSocket(id, this.socketHandlers(id), detail.head);
    this.socket.connect();
  }

  private socketHandlers(id: string): SessionSocketHandlers {
    return {
      onEvent: (e) => {
        this.state.applyEvent(e);
        // A first turn is when the server names an unnamed session, so pick the list
        // up now instead of leaving the row untitled until the turn ends.
        if (e.payload.kind === 'turn_started') this.refreshSessions();
        // kiro persists the session around now, so reconcile the list for its
        // real updatedAt, title and credits. Delayed until that settles.
        if (e.payload.kind === 'turn_ended') {
          setTimeout(() => this.refreshSessions(), this.turnEndedRefreshMs);
        }
      },
      onStatus: (status) => {
        this.state.setConnStatus(status);
        // The prompt that created the session, delivered once there is a socket.
        if (status === 'connected' && this.firstPrompt) {
          const held = this.firstPrompt;
          this.firstPrompt = null;
          this.deliver(held.id, held.content, held.attachments);
        }
      },
      onResync: async () => {
        const fresh = await this.api.getSession(id);
        if (this.openTarget !== id) return;
        this.state.loadDetail(fresh);
        this.socket?.reset(fresh.head);
      },
      onAck: (action, ok, error) => {
        if (ok) return;
        // The server explains every rejection; don't drop it on the floor.
        const reason = error ?? 'The server rejected the request.';
        if (action === 'prompt') {
          // The reason rides on the failed bubble, which is where the user
          // is already looking.
          if (this.lastSent) this.state.markPendingFailed(this.lastSent, reason);
          return;
        }
        // set_model / set_mode / cancel / exec_command have no bubble to
        // attach to, so this only reaches the console for now.
        console.error(`${ACTION_LABEL[action] ?? action} rejected:`, reason);
      },
      onFsChanged: (path) => this.state.bumpFsPath(path),
      onUnauthorized: () => {
        // The cookie is already invalid, so drop the session and show the gate
        // rather than looping on reconnects.
        this.closeSocket();
        this.state.clearActive();
        this.host?.onLock();
      },
      onServerError: (message) => {
        console.error('server error:', message);
      },
    };
  }

  // -------------------------------------------------------------------------
  // Creating
  // -------------------------------------------------------------------------

  async createSession(opts: CreateOpts): Promise<boolean> {
    // Enter the session view right away; it shows "Connecting" until ready.
    this.closeSocket();
    this.state.setConnStatus('connecting');
    this.state.setCreateError(null);
    this.lastCreateOpts = opts;
    try {
      const detail = await this.api.createSession({
        cwd: opts.cwd || undefined,
        agentId: opts.agentId,
        modelId: opts.modelId,
        // No directory named: the session gets one of its own.
        freshWorkspace: !opts.cwd,
      });
      this.refreshSessions();
      const id = detail.summary.sessionId;
      // Claim the route before navigating, so syncRoute leaves this one alone:
      // it is already open, with the prompt that created it on screen.
      this.handledRoute = id;
      this.isDraft = false;
      this.host?.navigate(pathForSession(id));
      void this.openSession(id, detail);
      return true;
    } catch (err) {
      // Keep the user on the chat pane and show what went wrong.
      this.state.setConnStatus('closed');
      this.state.setCreateError(
        err instanceof Error ? err.message : 'Failed to create session',
      );
      return false;
    }
  }

  retryCreate(): void {
    if (this.lastCreateOpts) void this.createSession(this.lastCreateOpts);
  }

  dismissCreateError(): void {
    this.state.setCreateError(null);
    this.host?.navigate('/');
  }

  /**
   * A new session costs nothing until there is something to say: the chat opens on a
   * draft route, and the first prompt is what creates the session.
   */
  startDraft(): void {
    this.openTarget = null;
    this.closeSocket();
    this.state.clearActive();
    this.state.setCreateError(null);
    this.host?.navigate(DRAFT_PATH);
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * Send a prompt. The user bubble shows immediately as "sending"; the server's
   * turn_started echo clears it, and a delivery failure flags it for retry.
   */
  send(content: PromptContentBlock[], attachments?: MessageAttachment[]): void {
    const id = `pending-${this.msgSeq++}`;
    // Text for the pending bubble, minus the machine-facing "Attached files:"
    // line (the transcript renders thumbnails instead).
    const text = stripAttachmentsLine(
      content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    );
    // An attachment of its own is a message, so the bubble no longer needs a stand-in label.
    this.state.addPending(id, text, attachments);

    if (this.isDraft) {
      // Create on demand, then deliver: the socket opens as part of going to the
      // new session, so the prompt waits for it rather than being dropped.
      // The pickers are live in a draft, so it is created with whatever they show.
      const { currentModeId, currentModelId } = this.state;
      void this.createSession({
        agentId: currentModeId,
        modelId: currentModelId,
        // Named on creation, so the row never appears as "Untitled session" for the
        // moment between the session existing and its first turn starting.
        title: titleFromPrompt(content),
      }).then((created) => {
        if (created) this.firstPrompt = { id, content, attachments };
        else this.state.markPendingFailed(id, 'Could not start the session.');
      });
      return;
    }
    this.deliver(id, content, attachments);
  }

  private deliver(
    id: string,
    content: PromptContentBlock[],
    attachments?: MessageAttachment[],
  ): void {
    this.lastSent = id;
    if (this.socket?.prompt(content, attachments)) return;
    // The socket wasn't open, so the server never saw this. Say so on the
    // bubble itself rather than leaving it unexplained.
    this.state.markPendingFailed(
      id,
      this.socket
        ? 'Not connected to the server - reconnecting. Retry once the status dot is green.'
        : 'No active session socket.',
    );
  }

  retrySend(id: string, text: string): void {
    this.state.markPendingSending(id);
    this.deliver(id, [{ type: 'text', text }]);
  }

  /**
   * Retry a turn that failed: send the same prompt again as a fresh message, so it
   * gets its own pending bubble and its own failure reason if it fails twice.
   */
  retryTurn(text: string): void {
    this.send([{ type: 'text', text }]);
  }

  // -------------------------------------------------------------------------
  // Control actions
  // -------------------------------------------------------------------------

  cancel(): void {
    this.socket?.cancel();
    this.state.markCancelling();
  }

  changeModel(modelId: string): void {
    this.socket?.setModel(modelId);
    this.state.setCurrentModel(modelId);
  }

  changeAgent(modeId: string): void {
    this.socket?.setMode(modeId);
    this.state.setCurrentAgent(modeId);
  }

  compact(): void {
    this.socket?.execCommand('compact');
    this.state.setCompacting(true);
    // Safety net: if the command never lands (e.g. the socket dropped) and no
    // compaction/status ever arrives, don't leave the UI stuck compacting.
    setTimeout(() => this.state.setCompacting(false), this.compactTimeoutMs);
  }

  /**
   * Restart the open session's kiro process, so a `.kiro` directory or an MCP server
   * added since it started is detected. The reply is a fresh detail, applied the way a
   * resync applies one; the pickers are refetched because a new agent only appears
   * once the server has re-read kiro's list.
   */
  async reloadSession(): Promise<void> {
    const id = this.state.activeId;
    // Scoped to this session: another one restarting is no reason to refuse this.
    if (!id || this.state.reloadingId === id) return;
    this.state.setReloadingId(id);
    try {
      const detail = await this.api.reloadSession(id);
      // Moved on while the process restarted: leave the new session alone.
      if (this.state.activeId !== id) return;
      this.state.loadDetail(detail);
      this.socket?.reset(detail.head);
      this.loadPickers();
    } catch (err) {
      // Guarded like the success path: don't blame the session the user moved to.
      if (this.state.activeId !== id) return;
      const detail = err instanceof Error ? err.message : 'The server rejected the reload.';
      this.state.setSessionNotice({
        title: "Couldn't reload the session",
        fix: detail,
        detail,
      });
    } finally {
      // Only if still ours - a later reload of another session owns the field now.
      if (this.state.reloadingId === id) this.state.setReloadingId(null);
    }
  }

  /**
   * The file panel declares which directories it is showing, and the server watches
   * exactly those. Resent on reconnect, since watches live with the connection
   * rather than the session.
   */
  watchPaths(paths: string[]): void {
    this.socket?.watchPaths(paths);
  }

  // -------------------------------------------------------------------------
  // Sessions in the list
  // -------------------------------------------------------------------------

  async deleteSession(id: string): Promise<void> {
    try {
      await this.api.deleteSession(id);
    } catch {
      console.error('delete session failed');
      this.refreshSessions();
      return;
    }
    if (this.state.activeId === id) this.host?.navigate('/');
    else this.refreshSessions();
  }

  async renameSession(id: string, title: string): Promise<void> {
    // Optimistic: update the list immediately, then persist.
    this.state.renameSessionRow(id, title);
    await this.api.renameSession(id, title).catch(() => {
      console.error('rename session failed');
    });
    this.refreshSessions();
  }

  /** Marked before the route changes, or the pane flashes back to the list. */
  markLoading(id: string): void {
    if (id === this.state.activeId) return;
    this.state.setLoadingSession(id);
  }

  /**
   * Lock the app: tear the socket down and clear the active session so nothing
   * lingers behind the login gate. The caller clears the cookie.
   */
  lock(): void {
    this.closeSocket();
    this.state.clearActive();
    this.host?.navigate('/', { replace: true });
    this.host?.onLock();
  }
  /** True when there is somewhere for a widget's message to go. */
  get canSend(): boolean {
    return this.isDraft || useStore.getState().activeId !== null;
  }
}

/** The one the app uses. Tests construct their own with substituted ports. */
export const sessionController = new SessionController();

/**
 * A widget asking to send a message as the user. Capped, and a no-op when there is
 * nowhere to send, so a stale frame can't send into the void. A draft counts: the
 * message creates the session, exactly as one typed into the composer would.
 */
export function sendWidgetPrompt(text: string): boolean {
  const clean = text.trim().slice(0, 4000);
  if (!clean || !sessionController.canSend) return false;
  sessionController.send([{ type: 'text', text: clean }]);
  return true;
}
