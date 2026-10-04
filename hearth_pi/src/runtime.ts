import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  configure,
  type Extension,
  type ConversationId,
} from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Catalog, Inputs, Proposals } from "./documents.js";
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

export class Runtime {
  readonly admission = new Serial();
  closing = false;
  private constructor(
    readonly harness: Harness,
    readonly model: { provider: string; modelId: string },
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
  ): Promise<Runtime> {
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
          },
          onReport: () => {},
        },
        ctx,
      );
      const runtime = new Runtime(harness, model, redactor(secrets), groups);
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
          const proposals = await tx.doc(
            Proposals,
            session.id as ConversationId,
          );
          for (const proposal of Object.values(proposals.items)) {
            if (proposal.status === "dispatching") proposal.status = "unknown";
            else if (proposal.status === "pending") {
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
            await runtime.place(session.id, requestId, input.content);
      }
      harness.resume();
      return runtime;
    } catch (error) {
      await db.close();
      throw error;
    }
  }
  async list(owner: string) {
    return ((await this.harness.snapshot(Catalog, ctx))?.items ?? []).filter(
      (s) => s.owner === owner,
    );
  }
  async session(owner: string, id: number) {
    insist(
      (await this.list(owner)).some((s) => s.id === id),
      "session_not_found",
      404,
    );
    const conversation = await this.harness.conversation(
      id as ConversationId,
      ctx,
    );
    insist(conversation, "session_not_found", 404);
    return conversation;
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
        await configure(tx, conversation.id, {
          model: this.model,
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
  async submit(
    owner: string,
    id: number,
    requestId: unknown,
    content: unknown,
  ): Promise<number> {
    const key = text(requestId, 80);
    insist(requestPattern.test(key));
    const message = this.redact(text(content, 4000));
    insist(this.redact(key) === key, "credentials_in_request_id");
    return this.admission.run(async () => {
      insist(!this.closing, "closing", 503);
      const conversation = await this.session(owner, id);
      const previous = (
        await this.harness.snapshot(Inputs, conversation.id, ctx)
      )?.requests[key];
      if (previous) {
        insist(previous.hash === digest(message), "idempotency_conflict", 409);
        return previous.submissionId || this.place(id, key, previous.content);
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
      insist(
        Buffer.byteLength(
          JSON.stringify((await conversation.context(ctx)).entries),
        ) < 524288,
        "transcript_limit_create_session",
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
          hash: digest(message),
          content: message,
          submissionId: 0,
          admitted: Date.now(),
        };
      }, ctx);
      return this.place(id, key, message);
    });
  }
  private async place(
    id: number,
    requestId: string,
    content: string,
  ): Promise<number> {
    const conversation = (await this.harness.conversation(
      id as ConversationId,
      ctx,
    ))!;
    const submission = await conversation.submit(
      { type: "input", content, requestId, whenBusy: "followUp" },
      ctx,
    );
    await conversation.commit(async (tx) => {
      (await tx.doc(Inputs, conversation.id)).requests[
        requestId
      ]!.submissionId = submission.id;
    }, ctx);
    return submission.id;
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
      return {
        view: view.value,
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
