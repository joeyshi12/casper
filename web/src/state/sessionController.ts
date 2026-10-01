import type {
  AgentsResponse,
  CreateChatRequest,
  ModelsResponse,
  MessageAttachment,
  PromptContentBlock,
  ChatDetail,
  ChatListResponse,
} from '@casper/shared';
import { stripAttachmentsLine, titleFromPrompt } from '@casper/shared';
import { api } from '../api/rest.js';
import { SessionSocket, type SessionSocketHandlers } from '../api/SessionSocket.js';
import { DRAFT_PATH, pathForChat } from '../util/route.js';
import { useStore } from './store.js';

export type CreateOpts = Omit<CreateChatRequest, 'freshWorkspace'>;

export interface SessionApi {
  listChats(): Promise<ChatListResponse>;
  getChat(id: string): Promise<ChatDetail>;
  createChat(req: CreateChatRequest): Promise<ChatDetail>;
  deleteChat(id: string): Promise<unknown>;
  renameChat(id: string, title: string): Promise<unknown>;
  reloadChat(id: string): Promise<ChatDetail>;
  models(): Promise<ModelsResponse>;
  agents(): Promise<AgentsResponse>;
}

export interface ControlledSocket {
  connect(): void;
  close(): void;
  reset(head: number): void;
  prompt(content: PromptContentBlock[], attachments?: MessageAttachment[]): boolean;
  cancel(): void;
  setMode(modeId: string): void;
  setModel(modelId: string): void;
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
        this.state.applyEvent(e);
        if (e.payload.kind === 'turn_started') this.refreshSessions();
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
      onResync: async () => {
        const fresh = await this.api.getChat(id);
        if (this.openTarget !== id) return;
        this.state.loadDetail(fresh);
        this.socket?.reset(fresh.head);
      },
      onAck: (action, ok, error) => {
        if (ok) return;
        const reason = error ?? 'The server rejected the request.';
        if (action === 'prompt') {
          if (this.lastSent) this.state.markPendingFailed(this.lastSent, reason);
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

  send(content: PromptContentBlock[], attachments?: MessageAttachment[]): void {
    const id = `pending-${this.msgSeq++}`;
    const text = stripAttachmentsLine(
      content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    );
    this.state.addPending({ id, text, attachments, content });

    if (this.isDraft) {
      const { currentModeId, currentModelId } = this.state;
      void this.createChat({
        agentId: currentModeId,
        modelId: currentModelId,
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
    this.state.markPendingSending(id);
    this.deliver(id, pending.content, pending.attachments);
  }

  retryTurn(text: string): void {
    this.send([{ type: 'text', text }]);
  }

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

export function sendWidgetPrompt(text: string): boolean {
  const clean = text.trim().slice(0, 4000);
  if (!clean || !sessionController.canSend) return false;
  sessionController.send([{ type: 'text', text: clean }]);
  return true;
}
