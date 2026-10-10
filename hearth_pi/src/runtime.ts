import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  configure,
  AgentDoc,
  InboxDoc,
  LiveDoc,
  type Extension,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { supportsThinking } from "./models.js";
import { LOCAL_PROVIDER } from "./local.js";
import { ownerKey } from "./memory.js";
import { OwnerProfile } from "./profile.js";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  Catalog,
  Inputs,
  Proposals,
  HomePermissions,
  ModelSelection,
} from "./documents.js";
import type { HomeActions } from "./home-actions.js";
import { HomeCanvas, scopedCanvas } from "./canvas.js";
import { WorkspaceGuard } from "./workspace.js";
import {
  Serial,
  insist,
  digest,
  text,
  requestPattern,
  redactor,
} from "./safety.js";
import {
  IMAGE_LIMITS,
  countImages,
  findImage,
  inputHash,
  parseImages,
  transcriptBytes,
  userContent,
  withoutImageData,
  type ImageAttachment,
} from "./images.js";

export class Runtime {
  readonly admission = new Serial();
  closing = false;
  homeActions?: HomeActions;
  private constructor(
    readonly harness: Harness,
    readonly model: { provider: string; modelId: string },
    readonly models: Models,
    readonly defaultThinkingLevel: ModelThinkingLevel,
    readonly redact: (value: string) => string,
    readonly groups: { home: Extension[]; workspace: Extension[] },
  ) {}
  static async open(
    dataDir: string,
    models: Models,
    model: { provider: string; modelId: string },
    extensions: Extension[] = [],
    secrets: readonly string[] = [],
    groups: { home: Extension[]; workspace: Extension[] } = {
      home: extensions,
      workspace: [],
    },
    homeActions?: HomeActions,
    defaultThinkingLevel: ModelThinkingLevel = "off",
  ): Promise<Runtime> {
    insist(
      supportsThinking(
        models,
        model.provider,
        model.modelId,
        defaultThinkingLevel,
      ) ||
        // An unconfigured local endpoint has no models yet; sessions wait for it.
        (model.provider === LOCAL_PROVIDER &&
          defaultThinkingLevel === "off" &&
          !models.getModel(model.provider, model.modelId)),
      "unsupported_default_thinking",
    );
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const db = await openNodeSqliteDatabase(join(dataDir, "hearth.sqlite"), {
      busyTimeoutMs: 0,
    });
    try {
      // Exclusive WAL ownership lasts for this connection, released by OS on death.
      await db.exec(
        "PRAGMA locking_mode = EXCLUSIVE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE; COMMIT",
      );
      const sync = await db.get<{ synchronous: number }>("PRAGMA synchronous");
      insist(sync?.synchronous === 2, "storage_not_full", 503);
      const registry = createRegistry();
      for (const extension of extensions) registry.install(extension);
      const storage = await SqliteStorage.open(db);
      const harness = await Harness.open(
        storage,
        {
          models,
          registry,
          settings: {
            retry: { enabled: false },
            compaction: { enabled: false },
            toolExecution: "sequential",
            stream: { timeoutMs: 60000, maxRetries: 0 },
          },
          conversationCreated: async (tx, record) => {
            await tx.doc(Inputs, record.id);
            await tx.doc(Proposals, record.id);
            await tx.doc(HomeCanvas, record.id);
            await tx.doc(ModelSelection, record.id);
          },
          onReport: () => {},
        },
        ctx,
      );
      const runtime = new Runtime(
        harness,
        model,
        models,
        defaultThinkingLevel,
        redactor(secrets),
        groups,
      );
      homeActions?.attach(runtime);
      await homeActions?.initialize();
      const unfinished = await harness.inspect(ctx);
      // Pending approvals do not survive a boot: this also fails closed on backup rollback.
      await harness.commit(async (tx) => {
        const catalog = await tx.doc(Catalog);
        for (const session of catalog.items) {
          // Adding the coding registry must never silently widen an older Home session.
          await configure(tx, session.id as ConversationId, {
            extensions: groups[session.kind ?? "home"],
          });
          if (
            session.kind === "workspace" &&
            unfinished.tasks.some(
              (task) => task.record.conversationId === session.id,
            )
          ) {
            const epoch = Object.keys(
              (await tx.doc(Inputs, session.id as ConversationId)).requests,
            ).length;
            (
              await tx.doc(WorkspaceGuard, session.id as ConversationId)
            ).blockedEpoch = epoch;
          }
          // Initialize the new latest-only document for pre-canvas sessions too.
          await tx.doc(HomeCanvas, session.id as ConversationId);
          await tx.doc(ModelSelection, session.id as ConversationId);
          const proposals = await tx.doc(
            Proposals,
            session.id as ConversationId,
          );
          for (const proposal of Object.values(proposals.items)) {
            if (proposal.status === "dispatching") {
              proposal.status = "unknown";
              (await tx.doc(HomePermissions)).actionRevision++;
            } else if (proposal.status === "pending") {
              proposal.status = "rejected";
              proposal.resolution =
                "Restart invalidated approval; request a new proposal.";
            }
          }
        }
      }, ctx);
      // A host request reservation and Pi admission are two commits: drain the gap idempotently.
      for (const session of (await harness.snapshot(Catalog, ctx))?.items ??
        []) {
        const requests =
          (await harness.snapshot(Inputs, session.id as ConversationId, ctx))
            ?.requests ?? {};
        for (const [requestId, input] of Object.entries(requests))
          if (!input.submissionId)
            await runtime.place(
              session.id,
              requestId,
              input.content,
              input.images,
            );
      }
      harness.resume();
      return runtime;
    } catch (error) {
      await db.close();
      throw error;
    }
  }
  /**
   * Owners allowed Code (workspace) sessions, set by the server from the App
   * configuration when the workspace is enabled. Undefined keeps only the
   * extension-group check (workspace off, or tests without a server).
   */
  workspaceOwners?: ReadonlySet<string>;
  private workspaceAllowed(owner: string) {
    return !this.workspaceOwners || this.workspaceOwners.has(owner);
  }
  // Another owner's earlier Code sessions stay hidden and refused while
  // they are not a workspace owner; nothing is deleted.
  async list(owner: string) {
    const allowed = this.workspaceAllowed(owner);
    return ((await this.harness.snapshot(Catalog, ctx))?.items ?? []).filter(
      (s) => s.owner === owner && (allowed || s.kind !== "workspace"),
    );
  }
  async session(owner: string, id: number) {
    const item = (
      (await this.harness.snapshot(Catalog, ctx))?.items ?? []
    ).find((s) => s.id === id && s.owner === owner);
    insist(item, "session_not_found", 404);
    insist(
      item.kind !== "workspace" || this.workspaceAllowed(owner),
      "workspace_not_allowed",
      403,
    );
    const conversation = await this.harness.conversation(
      id as ConversationId,
      ctx,
    );
    insist(conversation, "session_not_found", 404);
    return conversation;
  }
  // A new Home chat's model/thinking: the owner's Settings > You default
  // when it is still a currently selectable model (an owner may sign out of
  // an OAuth provider or an App restart may drop a model after it was set),
  // otherwise the installation default, exactly as before OwnerProfile
  // existed. Code/workspace sessions are unaffected \u2014 see create() below.
  private async ownerDefaults(tx: Tx, owner: string) {
    const profile = await tx.doc(OwnerProfile, ownerKey(owner), null);
    const defaultModel = profile.defaultModel;
    const valid =
      !!defaultModel &&
      this.modelChoices().some(
        (m) =>
          m.provider === defaultModel.provider && m.id === defaultModel.modelId,
      ) &&
      (!profile.defaultThinking ||
        supportsThinking(
          this.models,
          defaultModel.provider,
          defaultModel.modelId,
          profile.defaultThinking,
        ));
    return valid
      ? {
          model: {
            provider: defaultModel!.provider,
            modelId: defaultModel!.modelId,
          },
          thinkingLevel: profile.defaultThinking ?? this.defaultThinkingLevel,
        }
      : { model: this.model, thinkingLevel: this.defaultThinkingLevel };
  }
  async create(
    owner: string,
    title: unknown,
    creationId: unknown,
    kind: "home" | "workspace" = "home",
  ): Promise<number> {
    insist(
      kind === "home" ||
        (kind === "workspace" && this.groups.workspace.length > 0),
      "workspace_not_enabled",
      403,
    );
    insist(
      kind === "home" || this.workspaceAllowed(owner),
      "workspace_not_allowed",
      403,
    );
    const name = this.redact(text(title, 80));
    const key = text(creationId, 80);
    insist(requestPattern.test(key));
    insist(this.redact(key) === key, "credentials_in_request_id");
    return this.admission.run(async () => {
      insist(!this.closing, "closing", 503);
      return this.harness.commit(async (tx) => {
        const catalog = await tx.doc(Catalog);
        const old = catalog.items.find(
          (s) => s.owner === owner && s.creationId === key,
        );
        if (old) {
          insist(
            old.title === name && (old.kind ?? "home") === kind,
            "idempotency_conflict",
            409,
          );
          return old.id;
        }
        insist(
          catalog.items.length < 100 &&
            catalog.items.filter((s) => s.owner === owner).length < 30,
          "session_limit",
          429,
        );
        const conversation = await tx.createConversation({
          ownership: { kind: "ownerless" },
        });
        const { model, thinkingLevel } =
          kind === "home"
            ? await this.ownerDefaults(tx, owner)
            : { model: this.model, thinkingLevel: this.defaultThinkingLevel };
        await configure(tx, conversation.id, {
          model,
          thinkingLevel,
          extensions: this.groups[kind],
        });
        catalog.items.push({
          id: conversation.id,
          owner,
          title: name,
          created: Date.now(),
          creationId: key,
          kind,
        });
        return conversation.id;
      }, ctx);
    });
  }
  // Pi Durable has no API to erase a conversation or its entries: this only
  // removes it from the owner-scoped Catalog, which is what listing, 404s and
  // the per-owner/total session limits are keyed on. The committed transcript
  // stays in the private App store; see DOCS.md. Refused (409, distinct code)
  // while any safety barrier for this conversation is still open, so a removal
  // can never silently drop an unresolved proposal, running task or unplaced
  // input. Runs serialized on admission like create/submit, and every document
  // check is re-read inside the same commit that performs the removal.
  async delete(owner: string, id: number): Promise<void> {
    return this.admission.run(async () => {
      insist(!this.closing, "closing", 503);
      const conversation = await this.session(owner, id);
      const inspection = await this.harness.inspect(ctx);
      insist(
        !inspection.tasks.some((t) => t.record.conversationId === id),
        "delete_task_running",
        409,
      );
      await conversation.commit(async (tx) => {
        const catalog = await tx.doc(Catalog);
        const index = catalog.items.findIndex(
          (s) => s.id === id && s.owner === owner,
        );
        insist(index >= 0, "session_not_found", 404);
        const session = catalog.items[index]!;
        const proposals = await tx.doc(Proposals, conversation.id);
        insist(
          Object.values(proposals.items).every(
            (p) => !["pending", "dispatching", "unknown"].includes(p.status),
          ),
          "delete_proposal_unresolved",
          409,
        );
        const inputs = await tx.doc(Inputs, conversation.id);
        const live = await tx.doc(LiveDoc, conversation.id);
        const inbox = await tx.doc(InboxDoc, conversation.id);
        insist(
          Object.values(inputs.requests).every(
            (input) => input.submissionId > 0,
          ) &&
            !live.run &&
            !live.compactions?.length &&
            !inbox.items.length,
          "delete_session_busy",
          409,
        );
        if (session.kind === "workspace") {
          const guard = await tx.doc(WorkspaceGuard, conversation.id);
          const epoch = Object.keys(inputs.requests).length;
          insist(
            guard.blockedEpoch !== epoch || guard.blockedEpoch === 0,
            "delete_workspace_blocked",
            409,
          );
        }
        catalog.items.splice(index, 1);
      }, ctx);
    });
  }
  /**
   * Available OAuth providers besides the configured one, with whether they
   * are signed in. Set by the controller; empty keeps the configured provider
   * the only choice (offline demonstration, tests).
   */
  oauthProviders: () => readonly { provider: string; signedIn: boolean }[] =
    () => [];
  // The configured provider's in-process chat registry plus that of every
  // signed-in OAuth provider. These fields are projected explicitly: never
  // serialize a provider/model object. (provider, id) is the key.
  modelChoices() {
    const providers = [
      this.model.provider,
      ...this.oauthProviders()
        .filter((p) => p.signedIn && p.provider !== this.model.provider)
        .map((p) => p.provider),
    ];
    return providers.flatMap((provider) =>
      this.models
        .getModels(provider)
        .filter(
          (m) =>
            m.provider === provider &&
            /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,119}$/.test(m.id) &&
            !/^(sk-|bearer|eyJ)/i.test(m.id),
        )
        .slice(0, 200)
        .map((m) => ({ id: m.id, name: m.name.slice(0, 120), provider })),
    );
  }
  /** Providers a session may be committed to: configured and available OAuth. */
  private sessionProviders() {
    return [
      this.model.provider,
      ...this.oauthProviders().map((p) => p.provider),
    ];
  }
  /** The committed model provider of an owner's session, if any. */
  async sessionProvider(owner: string, id: number) {
    const conversation = await this.session(owner, id);
    return (await this.harness.snapshot(AgentDoc, conversation.id, ctx))?.model
      ?.provider;
  }
  async selectModel(
    owner: string,
    id: number,
    modelId: unknown,
    thinkingLevel: unknown,
    revision: unknown,
    provider?: unknown,
  ) {
    const desired = text(modelId, 120);
    insist(
      Number.isSafeInteger(revision) && (revision as number) >= 0,
      "invalid_revision",
    );
    const target =
      provider === undefined ? this.model.provider : text(provider, 64);
    if (target !== this.model.provider) {
      const oauth = this.oauthProviders().find((p) => p.provider === target);
      insist(oauth, "provider_unavailable", 403);
      insist(oauth.signedIn, "subscription_login_required", 409);
    }
    insist(
      this.modelChoices().some(
        (m) => m.provider === target && m.id === desired,
      ),
      "unsupported_model",
      400,
    );
    insist(
      typeof thinkingLevel === "string" &&
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
          thinkingLevel,
        ),
      "invalid_thinking_level",
    );
    insist(
      supportsThinking(
        this.models,
        target,
        desired,
        thinkingLevel as ModelThinkingLevel,
      ),
      "unsupported_thinking",
      400,
    );
    return this.admission.run(async () => {
      insist(!this.closing, "closing", 503);
      const conversation = await this.session(owner, id);
      const inspection = await this.harness.inspect(ctx);
      insist(
        !inspection.tasks.some((t) => t.record.conversationId === id),
        "session_busy",
        409,
      );
      return conversation.commit(async (tx) => {
        const selection = await tx.doc(ModelSelection, conversation.id);
        insist(selection.revision === revision, "stale_model_selection", 409);
        const live = await tx.doc(LiveDoc, conversation.id);
        const inbox = await tx.doc(InboxDoc, conversation.id);
        insist(
          !live.run && !live.compactions?.length && !inbox.items.length,
          "session_busy",
          409,
        );
        const inputs = await tx.doc(Inputs, conversation.id);
        insist(
          Object.values(inputs.requests).every(
            (input) => input.submissionId > 0,
          ),
          "session_busy",
          409,
        );
        const kind = (await tx.doc(Catalog)).items.find(
          (s) => s.id === id,
        )?.kind;
        if (kind === "workspace") {
          const guard = await tx.doc(WorkspaceGuard, conversation.id);
          insist(
            guard.blockedEpoch !== Object.keys(inputs.requests).length ||
              guard.blockedEpoch === 0,
            "workspace_continuation_blocked",
            409,
          );
        }
        const proposals = await tx.doc(Proposals, conversation.id);
        insist(
          Object.values(proposals.items).every(
            (p) => !["pending", "dispatching", "unknown"].includes(p.status),
          ),
          "action_unresolved",
          409,
        );
        const stored = await tx.doc(AgentDoc, conversation.id);
        insist(
          stored.model &&
            this.sessionProviders().includes(stored.model.provider),
          "unsupported_model",
          409,
        );
        if (
          stored.model.provider !== target ||
          stored.model.modelId !== desired ||
          (stored.thinkingLevel ?? "off") !== thinkingLevel
        ) {
          await configure(tx, conversation.id, {
            model: { provider: target, modelId: desired },
            thinkingLevel: thinkingLevel as ModelThinkingLevel,
          });
          selection.revision++;
        }
        return {
          model: { provider: target, modelId: desired },
          thinkingLevel,
          revision: selection.revision,
        };
      }, ctx);
    });
  }
  /** Whether the session's committed model accepts image input. */
  async imageInput(owner: string, id: number) {
    const conversation = await this.session(owner, id);
    const model =
      (await this.harness.snapshot(AgentDoc, conversation.id, ctx))?.model ??
      this.model;
    const resolved = this.models.getModel(model.provider, model.modelId);
    return {
      model: { provider: model.provider, modelId: model.modelId },
      images: !!resolved?.input.includes("image"),
    };
  }
  async submit(
    owner: string,
    id: number,
    requestId: unknown,
    content: unknown,
    attachments?: unknown,
  ): Promise<number> {
    const key = text(requestId, 80);
    insist(requestPattern.test(key));
    const images = parseImages(attachments);
    const message = this.redact(text(content, 4000, images.length ? 0 : 1));
    insist(this.redact(key) === key, "credentials_in_request_id");
    const hash = inputHash(message, images);
    return this.admission.run(async () => {
      insist(!this.closing, "closing", 503);
      const conversation = await this.session(owner, id);
      const previous = (
        await this.harness.snapshot(Inputs, conversation.id, ctx)
      )?.requests[key];
      if (previous) {
        insist(previous.hash === hash, "idempotency_conflict", 409);
        return (
          previous.submissionId ||
          this.place(id, key, previous.content, previous.images)
        );
      }
      if (images.length) {
        // Never drop an image silently: a text-only model would only see a
        // placeholder, so the owner is told instead.
        insist(
          (await this.list(owner)).find((s) => s.id === id)?.kind !==
            "workspace",
          "images_home_only",
          403,
        );
        insist(
          (await this.imageInput(owner, id)).images,
          "model_no_image_input",
          409,
        );
      }
      const inspection = await this.harness.inspect(ctx);
      insist(
        !inspection.tasks.some((t) => t.record.conversationId === id),
        "session_busy",
        409,
      );
      insist(
        new Set(inspection.tasks.map((t) => t.record.conversationId)).size < 4,
        "capacity",
        429,
      );
      const entries = (await conversation.context(ctx)).entries;
      insist(
        transcriptBytes(entries) < 524288,
        "transcript_limit_create_session",
        429,
      );
      insist(
        countImages(entries) + images.length <= IMAGE_LIMITS.perConversation,
        "image_limit_create_session",
        429,
      );
      await conversation.commit(async (tx) => {
        const inputs = await tx.doc(Inputs, conversation.id);
        insist(
          Object.keys(inputs.requests).length < 200,
          "input_limit_create_session",
          429,
        );
        inputs.requests[key] = {
          hash,
          content: message,
          ...(images.length ? { images } : {}),
          submissionId: 0,
          admitted: Date.now(),
          ...((await tx.doc(Catalog)).items.find((s) => s.id === id)?.kind !==
            "workspace" && this.homeActions
            ? { homePermission: await this.homeActions.bind(tx, owner) }
            : {}),
        };
      }, ctx);
      return this.place(id, key, message, images);
    });
  }
  private async place(
    id: number,
    requestId: string,
    content: string,
    images?: readonly ImageAttachment[],
  ): Promise<number> {
    const conversation = (await this.harness.conversation(
      id as ConversationId,
      ctx,
    ))!;
    const submission = await conversation.submit(
      {
        type: "input",
        content: userContent(content, images),
        requestId,
        whenBusy: "followUp",
      },
      ctx,
    );
    await conversation.commit(async (tx) => {
      const input = (await tx.doc(Inputs, conversation.id)).requests[
        requestId
      ]!;
      input.submissionId = submission.id;
      // The durable user message now carries the images.
      delete input.images;
    }, ctx);
    return submission.id;
  }
  /** One attached image of an owner's session, from its active transcript. */
  async image(owner: string, id: number, entryId: number, index: number) {
    const conversation = await this.session(owner, id);
    return findImage(
      (await conversation.context(ctx)).entries as unknown as {
        id: number;
        model?: readonly unknown[];
      }[],
      entryId,
      index,
    );
  }
  async snapshot(
    owner: string,
    id: number,
    visibleEntities: readonly string[] = [],
  ) {
    const conversation = await this.session(owner, id);
    const view = await conversation.viewState(ctx);
    try {
      const inputs = Object.values(
        (await this.harness.snapshot(Inputs, conversation.id, ctx))?.requests ??
          {},
      ).sort((a, b) => b.admitted - a.admitted);
      const lastId = inputs[0]?.submissionId;
      const last = lastId
        ? await (
            await this.harness.submission(
              lastId as import("@earendil-works/pi-durable").SubmissionId,
              ctx,
            )
          )?.status(ctx)
        : undefined;
      // Read the agent and CAS revision on one durable writer line. The
      // structural view doesn't expose arbitrary latest-only host documents.
      const committed = await conversation.commit(async (tx) => {
        const agent = await tx.doc(AgentDoc, conversation.id);
        const selection = await tx.doc(ModelSelection, conversation.id);
        return {
          model: agent.model
            ? { provider: agent.model.provider, modelId: agent.model.modelId }
            : undefined,
          thinkingLevel: agent.thinkingLevel ?? "off",
          revision: selection.revision,
        };
      }, ctx);
      const committedModel = committed.model;
      return {
        modelSelection: {
          model:
            committedModel &&
            this.sessionProviders().includes(committedModel.provider)
              ? {
                  provider: committedModel.provider,
                  modelId: committedModel.modelId,
                }
              : null,
          thinkingLevel: committed.thinkingLevel,
          revision: committed.revision,
        },
        // Whether attachments can be sent: the committed model reads images.
        imageInput:
          !!committedModel &&
          !!this.models
            .getModel(committedModel.provider, committedModel.modelId)
            ?.input.includes("image"),
        // Image bytes are served by the image route, never in snapshots.
        view: withoutImageData(view.value),
        homePermissions: this.homeActions
          ? await this.homeActions.settings(owner)
          : null,
        homeCanvas:
          (await this.list(owner)).find((s) => s.id === id)?.kind ===
          "workspace"
            ? null
            : scopedCanvas(
                (await this.harness.snapshot(HomeCanvas, conversation.id, ctx))
                  ?.current ?? null,
                visibleEntities,
              ),
        proposals:
          (await this.harness.snapshot(Proposals, conversation.id, ctx))
            ?.items ?? {},
        lastInput: last
          ? {
              id: last.id,
              status: last.status,
              reason: "reason" in last ? last.reason : "",
            }
          : null,
      };
    } finally {
      view.dispose();
    }
  }
  async close() {
    this.closing = true;
    await this.admission.run(() => this.harness.close(ctx));
  }
}
