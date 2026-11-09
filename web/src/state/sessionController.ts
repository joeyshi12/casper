import type {
  AgentsResponse,
  CreateChatRequest,
  ModelsResponse,
  MessageAttachment,
  PromptContentBlock,
  ChatDetail,
  ChatListResponse,
} from '@casper/shared';
import { ATTACHMENTS_PREFIX, stripAttachmentsLine } from '@casper/shared';
import { api } from '../api/rest.js';
import { SessionSocket, type SessionSocketHandlers } from '../api/SessionSocket.js';
import { DRAFT_PATH, pathForChat } from '../util/route.js';
import { useStore, type CasperState } from './store.js';

export type CreateOpts = Omit<CreateChatRequest, 'freshWorkspace'>;

export interface SessionApi {
  listChats(): Promise<ChatListResponse>;
  getChat(id: string): Promise<ChatDetail>;
  createChat(req: CreateChatRequest): Promise<ChatDetail>;
  deleteChat(id: string): Promise<unknown>;
  renameChat(id: string, title: string): Promise<unknown>;
  pinChat(id: string, pinned: boolean): Promise<unknown>;
  reloadChat(id: string): Promise<ChatDetail>;
  branchChat(id: string, messageId: string): Promise<ChatDetail>;
  rewindChat(id: string, messageId: string): Promise<ChatDetail>;
  models(): Promise<ModelsResponse>;
  agents(): Promise<AgentsResponse>;
}

export interface ControlledSocket {
  connect(): void;
  close(): void;
  reset(head: number): void;
  prompt(content: PromptContentBlock[], attachments?: MessageAttachment[], retry?: boolean): boolean;
  steer(text: string, clientId: string): boolean;
  cancel(): void;
  setMode(modeId: string): void;
  setModel(modelId: string): void;
  setEffort(effortLevel: string): void;
  watchPaths(paths: string[]): void;
  execCommand(command: string): void;
}

export type CreateSocket = (
  chatId: string,
  handlers: SessionSocketHandlers,
  startCursor: number,
) => ControlledSocket;

export interface ControllerHost {
  navigate: (path: string, opts?: { replace?: boolean }) => void;
  onLock: () => void;
}

export interface ControllerOptions {
  api?: SessionApi;
  createSocket?: CreateSocket;
  listCoalesceMs?: number;
  turnEndedRefreshMs?: number;
  compactTimeoutMs?: number;
}

// Human names for control actions, so a rejection reads as "Model change failed: ..."
// instead of the wire action name.
const ACTION_LABEL: Record<string, string> = {
  prompt: 'Message',
  cancel: 'Stop',
  set_mode: 'Agent change',
  set_model: 'Model change',
  set_effort: 'Effort change',
  steer: 'Message',
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
  private openTarget: string | null = null;
  private handledRoute: string | null | undefined = undefined;
  private isDraft = false;
  private lastSent: string | null = null;
  private lastSteer: string | null = null;
  private msgSeq = 0;
  private firstPrompt: {
    id: string;
    content: PromptContentBlock[];
    attachments?: MessageAttachment[];
  } | null = null;
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

  attach(host: ControllerHost): void {
    this.host = host;
  }

  private get state() {
    return useStore.getState();
  }

  /* Within listCoalesceMs, calls collapse into one request; only the newest reply
     is applied, so a late answer from before a session was named can't undo its title. */
  refreshSessions(): void {
    if (this.listTimer !== null) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      const seq = ++this.listSeq;
      this.api
        .listChats()
        .then((r) => {
          if (seq === this.listSeq) this.state.setChats(r.chats);
        })
        .catch(() => {});
    }, this.listCoalesceMs);
  }

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


  syncRoute(routeSessionId: string | null, isDraft: boolean): void {
    this.isDraft = isDraft;
    if (isDraft && !this.state.chatId) this.state.newChatId();
    if (this.handledRoute === routeSessionId) return;
    this.handledRoute = routeSessionId;
    if (routeSessionId) {
      void this.openChat(routeSessionId);
    } else {
      this.openTarget = null;
      this.closeSocket();
      const continuingDraft = this.state.activeId === null && this.state.chatId !== null;
      this.state.clearActive();
      if (!continuingDraft) this.state.newChatId();
      this.refreshSessions();
    }
  }

  closeSocket(): void {
    this.socket?.close();
    this.socket = null;
  }

  async openChat(id: string, adopted?: ChatDetail): Promise<void> {
    if (this.state.activeId === id) return;
    this.openTarget = id;
    this.closeSocket();
    this.state.setConnStatus('connecting');
    if (!adopted) this.state.setLoadingChat(id);

    let detail: ChatDetail;
    if (adopted) {
      detail = adopted;
    } else {
      try {
        detail = await this.api.getChat(id);
      } catch (err) {
        if (this.openTarget !== id) return;
        this.state.setConnStatus('closed');
        this.state.setLoadingChat(null);
        console.error('open session failed:', err);
        this.host?.navigate('/', { replace: true });
        return;
      }
    }
    if (this.openTarget !== id) return;
    this.state.loadDetail(detail, { keepPending: Boolean(adopted) });

    this.socket = this.createSocket(id, this.socketHandlers(id), detail.head);
    this.socket.connect();
  }

  private socketHandlers(id: string): SessionSocketHandlers {
    return {
      onEvent: (e) => {
        const fresh = e.seq > this.state.appliedSeq;
        this.state.applyEvent(e);
        if (!fresh) return;
        if (e.payload.kind === 'turn_started' || e.payload.kind === 'title_changed') this.refreshSessions();
        // The chat moved to another kiro session, so its transcript is refetched.
        if (e.payload.kind === 'history_replaced') void this.refetch(id);
        // kiro persists the session shortly after a turn ends; this delay waits for that.
        if (e.payload.kind === 'turn_ended') {
          setTimeout(() => this.refreshSessions(), this.turnEndedRefreshMs);
        }
      },
      onStatus: (status) => {
        this.state.setConnStatus(status);
        if (status === 'connected' && this.firstPrompt) {
          const held = this.firstPrompt;
          this.firstPrompt = null;
          this.deliver(held.id, held.content, held.attachments);
        }
      },
      onResync: () => this.refetch(id),
      onAck: (action, ok, error) => {
        if (ok) return;
        const reason = error ?? 'The server rejected the request.';
        if (action === 'prompt') {
          if (this.lastSent) this.state.markPendingFailed(this.lastSent, reason);
          return;
        }
        if (action === 'steer') {
          if (this.lastSteer) this.state.markPendingFailed(this.lastSteer, reason);
          return;
        }
        console.error(`${ACTION_LABEL[action] ?? action} rejected:`, reason);
      },
      onFsChanged: (path) => this.state.bumpFsPath(path),
      onUnauthorized: () => {
        this.closeSocket();
        this.state.clearActive();
        this.host?.onLock();
      },
      onServerError: (message) => {
        console.error('server error:', message);
      },
    };
  }

  private async refetch(id: string): Promise<void> {
    const fresh = await this.api.getChat(id);
    if (this.openTarget !== id) return;
    this.state.loadDetail(fresh);
    this.socket?.reset(fresh.head);
  }

  async createChat(opts: CreateOpts): Promise<boolean> {
    this.closeSocket();
    this.state.setConnStatus('connecting');
    this.state.setCreateError(null);
    this.lastCreateOpts = opts;
    try {
      const detail = await this.api.createChat({
        chatId: this.state.chatId ?? undefined,
        cwd: opts.cwd || undefined,
        agentId: opts.agentId,
        modelId: opts.modelId,
        effortLevel: opts.effortLevel,
        freshWorkspace: !opts.cwd,
      });
      this.refreshSessions();
      const id = detail.summary.chatId;
      this.handledRoute = id;
      this.isDraft = false;
      this.host?.navigate(pathForChat(id));
      void this.openChat(id, detail);
      return true;
    } catch (err) {
      this.state.setConnStatus('closed');
      this.state.setCreateError(
        err instanceof Error ? err.message : 'Failed to create session',
      );
      return false;
    }
  }

  retryCreate(): void {
    if (this.lastCreateOpts) void this.createChat(this.lastCreateOpts);
  }

  dismissCreateError(): void {
    this.state.setCreateError(null);
    this.host?.navigate('/');
  }

  startDraft(): void {
    this.openTarget = null;
    this.closeSocket();
    this.state.clearActive();
    this.state.newChatId();
    this.state.setCreateError(null);
    this.host?.navigate(DRAFT_PATH);
  }

  send(content: PromptContentBlock[], attachments?: MessageAttachment[], opts: { retry?: boolean } = {}): void {
    const id = `pending-${this.msgSeq++}`;
    const text = stripAttachmentsLine(
      content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    );
    this.state.addPending({ id, text, attachments, content });

    if (this.isDraft) {
      const { currentModeId, currentModelId, currentEffort } = this.state;
      void this.createChat({
        agentId: currentModeId,
        modelId: currentModelId,
        effortLevel: currentEffort,
      }).then((created) => {
        if (created) this.firstPrompt = { id, content, attachments };
        else this.state.markPendingFailed(id, 'Could not start the session.');
      });
      return;
    }
    this.deliver(id, content, attachments, opts.retry);
  }

  /** Sends a message into the turn that is running. It waits below the turn until the
   *  model reads it, and comes back as failed if the turn ends first. */
  steer(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    const id = `pending-${this.msgSeq++}`;
    this.state.addPending({ id, text: clean, content: [{ type: 'text', text: clean }], steer: true });
    this.deliverSteer(id, clean);
  }

  private deliverSteer(id: string, text: string): void {
    this.lastSteer = id;
    if (this.socket?.steer(text, id)) return;
    this.state.markPendingFailed(id, 'Not connected to the server - reconnecting. Retry once the status dot is green.');
  }

  private deliver(
    id: string,
    content: PromptContentBlock[],
    attachments?: MessageAttachment[],
    retry = false,
  ): void {
    this.lastSent = id;
    if (this.socket?.prompt(content, attachments, retry)) return;
    this.state.markPendingFailed(
      id,
      this.socket
        ? 'Not connected to the server - reconnecting. Retry once the status dot is green.'
        : 'No active session socket.',
    );
  }

  retrySend(id: string): void {
    const pending = this.state.pending.find((p) => p.id === id);
    if (!pending) return;
    // A steer the turn did not read goes into the turn still running, or else as a prompt.
    if (pending.steer && this.state.observability.turnStatus === 'running') {
      this.state.markPendingSending(id);
      this.deliverSteer(id, pending.text);
      return;
    }
    if (pending.steer) {
      this.state.dropPending(id);
      this.send(pending.content);
      return;
    }
    this.state.markPendingSending(id);
    this.deliver(id, pending.content, pending.attachments);
  }

  retryTurn(text: string): void {
    this.send([{ type: 'text', text }], undefined, { retry: true });
  }

  cancel(): void {
    this.socket?.cancel();
    this.state.markCancelling();
  }

  changeModel(modelId: string): void {
    this.socket?.setModel(modelId);
    this.state.setCurrentModel(modelId);
    // A draft takes the new model's default effort. A chat's comes back from kiro.
    if (!this.socket) this.state.setCurrentEffort(undefined);
  }

  changeEffort(effortLevel: string): void {
    this.socket?.setEffort(effortLevel);
    this.state.setCurrentEffort(effortLevel);
  }

  /** Opens a new chat holding this one's conversation up to the turn of a prompt. */
  async branchFrom(messageId: string): Promise<void> {
    const id = this.state.activeId;
    if (!id) return;
    try {
      const detail = await this.api.branchChat(id, messageId);
      this.refreshSessions();
      const branchId = detail.summary.chatId;
      this.handledRoute = branchId;
      this.host?.navigate(pathForChat(branchId));
      await this.openChat(branchId, detail);
    } catch (err) {
      this.cutFailed(id, "Couldn't branch the chat", err);
    }
  }

  /** Cuts the chat back to before a prompt, then sends `text` in its place with the
   *  prompt's attachments. Resolves false if the rewind was refused. */
  async editPrompt(messageId: string, text: string, attachments?: MessageAttachment[]): Promise<boolean> {
    const id = this.state.activeId;
    if (!id) return false;
    let detail: ChatDetail;
    try {
      detail = await this.api.rewindChat(id, messageId);
    } catch (err) {
      this.cutFailed(id, "Couldn't edit the message", err);
      return false;
    }
    if (this.state.activeId !== id) return false;
    this.state.loadDetail(detail);
    this.socket?.reset(detail.head);
    this.refreshSessions();
    const content: PromptContentBlock[] = [];
    if (attachments?.length) {
      content.push({ type: 'text', text: ATTACHMENTS_PREFIX + attachments.map((a) => a.path).join(', ') + '\n' });
    }
    if (text.trim()) content.push({ type: 'text', text: text.trim() });
    if (content.length > 0) this.send(content, attachments);
    return true;
  }

  private cutFailed(id: string, title: string, err: unknown): void {
    if (this.state.activeId !== id) return;
    const detail = err instanceof Error ? err.message : 'The server rejected the request.';
    this.state.setChatNotice({ title, fix: detail, detail });
  }

  changeAgent(modeId: string): void {
    this.socket?.setMode(modeId);
    this.state.setCurrentAgent(modeId);
  }

  compact(): void {
    this.socket?.execCommand('compact');
    this.state.setCompacting(true);
    setTimeout(() => this.state.setCompacting(false), this.compactTimeoutMs);
  }

  async reloadChat(): Promise<void> {
    const id = this.state.activeId;
    if (!id || this.state.reloadingId === id) return;
    this.state.setReloadingId(id);
    try {
      const detail = await this.api.reloadChat(id);
      if (this.state.activeId !== id) return;
      this.state.loadDetail(detail);
      this.socket?.reset(detail.head);
      this.loadPickers();
    } catch (err) {
      if (this.state.activeId !== id) return;
      const detail = err instanceof Error ? err.message : 'The server rejected the reload.';
      this.state.setChatNotice({
        title: "Couldn't reload the session",
        fix: detail,
        detail,
      });
    } finally {
      if (this.state.reloadingId === id) this.state.setReloadingId(null);
    }
  }

  watchPaths(paths: string[]): void {
    this.socket?.watchPaths(paths);
  }

  async deleteChat(id: string): Promise<void> {
    try {
      await this.api.deleteChat(id);
    } catch {
      console.error('delete session failed');
      this.refreshSessions();
      return;
    }
    if (this.state.activeId === id) this.host?.navigate('/');
    else this.refreshSessions();
  }

  async renameChat(id: string, title: string): Promise<void> {
    this.state.renameChatRow(id, title);
    await this.api.renameChat(id, title).catch(() => {
      console.error('rename session failed');
    });
    this.refreshSessions();
  }

  async pinChat(id: string, pinned: boolean): Promise<void> {
    this.state.pinChatRow(id, pinned);
    await this.api.pinChat(id, pinned).catch(() => {
      console.error('pin session failed');
    });
    this.refreshSessions();
  }

  goToChat(id: string): void {
    this.host?.navigate(pathForChat(id));
  }

  markLoading(id: string): void {
    if (id === this.state.activeId) return;
    this.state.setLoadingChat(id);
  }

  lock(): void {
    this.closeSocket();
    this.state.clearActive();
    this.host?.navigate('/', { replace: true });
    this.host?.onLock();
  }

  get canSend(): boolean {
    return this.isDraft || useStore.getState().activeId !== null;
  }
}

export const sessionController = new SessionController();

/** Whether a prompt can be sent now: the same conditions under which the composer sends. */
export function promptsAccepted(s: Pick<CasperState, 'observability'>): boolean {
  return s.observability.turnStatus === 'idle' && !s.observability.compacting;
}

export function sendWidgetPrompt(text: string): boolean {
  const clean = text.trim().slice(0, 4000);
  if (!clean || !sessionController.canSend || !promptsAccepted(useStore.getState())) return false;
  sessionController.send([{ type: 'text', text: clean }]);
  return true;
}
