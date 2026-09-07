import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { expect, it } from "vitest";
import { agents, issueComments, issueRecoveryActions, issues, issueStatusOperations, principalPermissionGrants } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("guarded issue closure", () => {
  const ctx = useEmbeddedPostgres("paperclip-guarded-closure-", {
    resetEach: resetCompanyIssueFixtures,
  });

  async function seedIssue(status = "todo") {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Guarded closure");
    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId: company.companyId,
      title: "Guarded closure target",
      status,
      priority: "medium",
    });
    return { ...company, issueId, app: routeApp(ctx.db, company.actor, issueRoutes) };
  }

  async function seedAgentIssue(status = "in_progress") {
    const seeded = await seedIssue(status);
    const agentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: agentId,
      companyId: seeded.companyId,
      name: `agent-${agentId}`,
      role: "worker",
      title: "Worker",
      capabilities: "",
      adapterType: "process",
      adapterConfig: {},
      permissions: {},
    });
    await ctx.db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, seeded.issueId));
    const actor = {
      type: "agent",
      source: "agent_jwt",
      agentId,
      companyId: seeded.companyId,
    };
    return {
      ...seeded,
      agentId,
      agentApp: routeApp(ctx.db, actor as any, issueRoutes),
    };
  }

  async function readIssue(issueId: string) {
    return ctx.db
      .select({
        status: issues.status,
        statusVersion: issues.statusVersion,
        issueMutationVersion: issues.issueMutationVersion,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
  }

  async function countRows(issueId: string) {
    const [comments, operations] = await Promise.all([
      ctx.db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, issueId)),
      ctx.db.select({ id: issueStatusOperations.id }).from(issueStatusOperations).where(eq(issueStatusOperations.issueId, issueId)),
    ]);
    return { comments: comments.length, operations: operations.length };
  }

  it("applies a matching closure once and replays a lost response without duplicate effects", async () => {
    const seeded = await seedIssue();
    const body = {
      operationId: "factory:no-change:job-1",
      operationKind: "verified_no_change_closure",
      expectedStatus: "todo",
      expectedStatusVersion: 0,
      expectedMutationVersion: 0,
      status: "done",
      comment: "Verified no-change closure.",
      closureIdentity: "factory-job-1:no-change",
      closureDigest: "sha256:verified",
    };

    const first = await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/guarded-closure`)
      .send(body)
      .expect(200);
    expect(first.body).toMatchObject({
      applied: true,
      replayed: false,
      issue: { id: seeded.issueId, status: "done", statusVersion: 1, issueMutationVersion: 2 },
    });

    const replay = await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/guarded-closure`)
      .send(body)
      .expect(200);
    expect(replay.body).toMatchObject({
      applied: true,
      replayed: true,
      issue: { id: seeded.issueId, status: "done", statusVersion: 1, issueMutationVersion: 2 },
      commentId: first.body.commentId,
    });
    await expect(countRows(seeded.issueId)).resolves.toEqual({ comments: 1, operations: 1 });
  });

  it("reads an applied guarded operation receipt after the original response is lost", async () => {
    const seeded = await seedIssue();
    const body = {
      operationId: "factory:no-change:receipt-lost-response",
      operationKind: "verified_no_change_closure",
      expectedStatus: "todo",
      expectedStatusVersion: 0,
      expectedMutationVersion: 0,
      status: "done",
      comment: "Verified no-change closure receipt.",
      closureIdentity: "factory-job-receipt:no-change",
      closureDigest: "sha256:receipt",
    };

    const applied = await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/guarded-closure`)
      .send(body)
      .expect(200);
    await expect(countRows(seeded.issueId)).resolves.toEqual({ comments: 1, operations: 1 });

    const receipt = await request(seeded.app)
      .get(`/api/issues/${seeded.issueId}/guarded-operations/${encodeURIComponent(body.operationId)}`)
      .expect(200);
    expect(receipt.body).toMatchObject({
      issueId: seeded.issueId,
      operationId: body.operationId,
      operationKind: "verified_no_change_closure",
      operationDigest: expect.stringMatching(/^sha256:/),
      applied: true,
      commentId: applied.body.commentId,
      response: {
        applied: true,
        replayed: false,
        issue: { id: seeded.issueId, status: "done" },
        commentId: applied.body.commentId,
      },
    });
    await expect(countRows(seeded.issueId)).resolves.toEqual({ comments: 1, operations: 1 });
  });

  it("returns 404 for absent guarded operation receipts without creating effects", async () => {
    const seeded = await seedIssue("in_progress");
    await expect(countRows(seeded.issueId)).resolves.toEqual({ comments: 0, operations: 0 });

    await request(seeded.app)
      .get(`/api/issues/${seeded.issueId}/guarded-operations/${encodeURIComponent("factory:missing")}`)
      .expect(404);

    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "in_progress", statusVersion: 0, issueMutationVersion: 0 });
    await expect(countRows(seeded.issueId)).resolves.toEqual({ comments: 0, operations: 0 });
  });

  it("does not reveal guarded operation receipts through another issue", async () => {
    const seeded = await seedIssue();
    const otherIssueId = randomUUID();
    const body = {
      operationId: "factory:no-change:cross-issue",
      operationKind: "verified_no_change_closure",
      expectedStatus: "todo",
      expectedStatusVersion: 0,
      expectedMutationVersion: 0,
      status: "done",
      comment: "Closure belongs to the first issue.",
    };
    await ctx.db.insert(issues).values({
      id: otherIssueId,
      companyId: seeded.companyId,
      title: "Other guarded receipt target",
      status: "todo",
      priority: "medium",
    });

    await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/guarded-closure`)
      .send(body)
      .expect(200);

    await request(seeded.app)
      .get(`/api/issues/${otherIssueId}/guarded-operations/${encodeURIComponent(body.operationId)}`)
      .expect(404);
    await expect(readIssue(otherIssueId)).resolves.toMatchObject({ status: "todo", statusVersion: 0, issueMutationVersion: 0 });
  });

  it("requires ordinary issue access to read guarded operation receipts", async () => {
    const seeded = await seedIssue();
    const body = {
      operationId: "factory:no-change:auth-scoped",
      operationKind: "verified_no_change_closure",
      expectedStatus: "todo",
      expectedStatusVersion: 0,
      expectedMutationVersion: 0,
      status: "done",
      comment: "Closure receipt is scoped to issue visibility.",
    };
    await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/guarded-closure`)
      .send(body)
      .expect(200);

    const restrictedAgentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: restrictedAgentId,
      companyId: seeded.companyId,
      name: `restricted-${restrictedAgentId}`,
      role: "worker",
      title: "Restricted",
      capabilities: "",
      adapterType: "process",
      adapterConfig: {},
      permissions: {},
    });
    const restrictedApp = routeApp(ctx.db, {
      type: "agent",
      source: "agent_jwt",
      agentId: restrictedAgentId,
      companyId: seeded.companyId,
      keyId: randomUUID(),
      keyScope: { kind: "task_bridge", parentIssueId: randomUUID() },
    } as any, issueRoutes);

    await request(restrictedApp)
      .get(`/api/issues/${seeded.issueId}/guarded-operations/${encodeURIComponent(body.operationId)}`)
      .expect(403);
    await expect(countRows(seeded.issueId)).resolves.toEqual({ comments: 1, operations: 1 });
  });

  it("allows receipt lookup after monitor authority is revoked without attempting a first mutation", async () => {
    const seeded = await seedAgentIssue("in_review");
    const body = {
      operationId: "factory:observer:receipt-after-revoke",
      operationKind: "guarded_status_update",
      expectedStatus: "in_review",
      expectedStatusVersion: 0,
      expectedMutationVersion: 1,
      status: "in_review",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor: {
          kind: "external_service",
          nextCheckAt: "2026-09-06T12:00:00.000Z",
          serviceName: "Software Factory",
          externalRef: "chain:receipt-after-revoke",
          scheduledBy: "assignee",
          maxAttempts: 6,
          recoveryPolicy: "wake_owner",
        },
      },
    };

    await request(seeded.agentApp)
      .post(`/api/issues/${seeded.issueId}/guarded-status`)
      .send(body)
      .expect(200);
    await ctx.db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, seeded.agentId));
    const scopedApp = routeApp(ctx.db, {
      type: "agent",
      source: "agent_jwt",
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      keyId: randomUUID(),
      keyScope: { kind: "task_bridge", parentIssueId: randomUUID() },
    } as any, issueRoutes);

    const receipt = await request(scopedApp)
      .get(`/api/issues/${seeded.issueId}/guarded-operations/${encodeURIComponent(body.operationId)}`)
      .expect(200);
    expect(receipt.body).toMatchObject({
      issueId: seeded.issueId,
      operationId: body.operationId,
      operationKind: "guarded_status_update",
      applied: true,
      response: { applied: true, issue: { id: seeded.issueId, status: "in_review" } },
    });
    await expect(countRows(seeded.issueId)).resolves.toEqual({ comments: 0, operations: 1 });
  });

  it("rejects a reused operation identity with a changed body", async () => {
    const seeded = await seedIssue();
    const body = {
      operationId: "factory:no-change:job-2",
      expectedStatus: "todo",
      expectedStatusVersion: 0,
      expectedMutationVersion: 0,
      status: "done",
      comment: "First closure body.",
    };

    await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/guarded-closure`)
      .send(body)
      .expect(200);
    await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/guarded-closure`)
      .send({ ...body, comment: "Changed closure body." })
      .expect(409);
    await expect(countRows(seeded.issueId)).resolves.toEqual({ comments: 1, operations: 1 });
  });

  it("records expected-version failures and replays them without later applying", async () => {
    const seeded = await seedIssue();
    await ctx.db.update(issues).set({ status: "cancelled", updatedAt: new Date() }).where(eq(issues.id, seeded.issueId));
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "cancelled", statusVersion: 1, issueMutationVersion: 1 });

    const body = {
      operationId: "factory:no-change:job-3",
      expectedStatus: "todo",
      expectedStatusVersion: 0,
      expectedMutationVersion: 0,
      status: "done",
      comment: "Stale observer closure.",
    };

    const first = await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/guarded-closure`)
      .send(body)
      .expect(409);
    expect(first.body).toMatchObject({
      applied: false,
      replayed: false,
      preconditionFailure: {
        actualStatus: "cancelled",
        actualStatusVersion: 1,
        actualMutationVersion: 1,
        expectedStatus: "todo",
        expectedStatusVersion: 0,
        expectedMutationVersion: 0,
      },
    });

    const replay = await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/guarded-closure`)
      .send(body)
      .expect(409);
    expect(replay.body).toMatchObject({ applied: false, replayed: true });
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "cancelled", statusVersion: 1, issueMutationVersion: 1 });
    await expect(countRows(seeded.issueId)).resolves.toEqual({ comments: 0, operations: 1 });
  });

  it("does not let a stale observer reopen a terminal issue", async () => {
    const seeded = await seedIssue("done");
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "done", statusVersion: 0 });

    const stale = await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/guarded-closure`)
      .send({
        operationId: "factory:no-change:job-4",
      expectedStatus: "in_review",
      expectedStatusVersion: 0,
      expectedMutationVersion: 0,
      status: "done",
        comment: "Old observer closure.",
      })
      .expect(409);
    expect(stale.body).toMatchObject({
      applied: false,
      preconditionFailure: {
        actualStatus: "done",
        expectedStatus: "in_review",
      },
    });
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "done", statusVersion: 0, issueMutationVersion: 0 });
  });

  it("rejects a delayed guarded observer update after a guarded closure commits", async () => {
    const seeded = await seedIssue("in_progress");
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "in_progress", statusVersion: 0, issueMutationVersion: 0 });

    await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/guarded-closure`)
      .send({
        operationId: "factory:no-change:job-5",
        operationKind: "verified_no_change_closure",
        expectedStatus: "in_progress",
        expectedStatusVersion: 0,
        expectedMutationVersion: 0,
        status: "done",
        comment: "Verified no-change closure won the race.",
      })
      .expect(200);

    const delayedObserver = await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/guarded-status`)
      .send({
        operationId: "factory:observer:job-5:delayed",
        operationKind: "guarded_status_update",
        expectedStatus: "in_progress",
        expectedStatusVersion: 0,
        expectedMutationVersion: 0,
        status: "in_review",
        comment: "Delayed observer saw an old running snapshot.",
      })
      .expect(409);
    expect(delayedObserver.body).toMatchObject({
      applied: false,
      preconditionFailure: {
        actualStatus: "done",
        actualStatusVersion: 1,
        actualMutationVersion: 2,
        expectedStatus: "in_progress",
        expectedStatusVersion: 0,
        expectedMutationVersion: 0,
      },
    });
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "done", statusVersion: 1, issueMutationVersion: 2 });
    await expect(countRows(seeded.issueId)).resolves.toEqual({ comments: 1, operations: 2 });
  });

  it("increments statusVersion on ordinary cancellation so guarded observers cannot overwrite it", async () => {
    const seeded = await seedIssue("in_progress");
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "in_progress", statusVersion: 0, issueMutationVersion: 0 });

    await request(seeded.app)
      .patch(`/api/issues/${seeded.issueId}`)
      .send({
        status: "cancelled",
        comment: "Human cancelled the issue while an observer was delayed.",
      })
      .expect(200);
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "cancelled", statusVersion: 1, issueMutationVersion: 3 });

    const delayedObserver = await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/guarded-status`)
      .send({
        operationId: "factory:observer:job-6:delayed",
        operationKind: "guarded_status_update",
        expectedStatus: "in_progress",
        expectedStatusVersion: 0,
        expectedMutationVersion: 0,
        status: "in_review",
        comment: "Delayed observer saw an old running snapshot.",
      })
      .expect(409);
    expect(delayedObserver.body).toMatchObject({
      applied: false,
      preconditionFailure: {
        actualStatus: "cancelled",
        actualStatusVersion: 1,
        actualMutationVersion: 3,
      },
    });
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "cancelled", statusVersion: 1, issueMutationVersion: 3 });
  });

  it("increments only mutation revision on ordinary non-status edits and blocks stale closure", async () => {
    const seeded = await seedIssue("in_progress");
    await request(seeded.app)
      .patch(`/api/issues/${seeded.issueId}`)
      .send({
        description: "Human refined the issue evidence while an observer was delayed.",
      })
      .expect(200);
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({
      status: "in_progress",
      statusVersion: 0,
      issueMutationVersion: 1,
    });

    const staleClosure = await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/guarded-closure`)
      .send({
        operationId: "factory:no-change:job-7",
        operationKind: "verified_no_change_closure",
        expectedStatus: "in_progress",
        expectedStatusVersion: 0,
        expectedMutationVersion: 0,
        status: "done",
        comment: "Stale closure missed the human edit.",
      })
      .expect(409);
    expect(staleClosure.body).toMatchObject({
      applied: false,
      preconditionFailure: {
        actualStatus: "in_progress",
        actualStatusVersion: 0,
        actualMutationVersion: 1,
        expectedMutationVersion: 0,
      },
    });
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "in_progress", statusVersion: 0, issueMutationVersion: 1 });
  });

  it("increments only mutation revision on comments and blocks stale observer updates", async () => {
    const seeded = await seedIssue("in_progress");
    await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/comments`)
      .send({
        body: "Human added context while an observer was delayed.",
      })
      .expect(201);
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({
      status: "in_progress",
      statusVersion: 0,
      issueMutationVersion: 2,
    });

    const staleObserver = await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/guarded-status`)
      .send({
        operationId: "factory:observer:job-8:delayed",
        operationKind: "guarded_status_update",
        expectedStatus: "in_progress",
        expectedStatusVersion: 0,
        expectedMutationVersion: 0,
        status: "in_review",
        comment: "Stale observer missed the human comment.",
      })
      .expect(409);
    expect(staleObserver.body).toMatchObject({
      applied: false,
      preconditionFailure: {
        actualStatus: "in_progress",
        actualStatusVersion: 0,
        actualMutationVersion: 2,
        expectedMutationVersion: 0,
      },
    });
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "in_progress", statusVersion: 0, issueMutationVersion: 2 });
  });

  it("denies guarded blocked-to-todo resume without the ordinary explicit resume path", async () => {
    const seeded = await seedIssue("blocked");
    await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/guarded-status`)
      .send({
        operationId: "factory:observer:blocked-resume",
        operationKind: "guarded_status_update",
        expectedStatus: "blocked",
        expectedStatusVersion: 0,
        expectedMutationVersion: 0,
        status: "todo",
        comment: "This endpoint cannot resume blocked work.",
      })
      .expect(422);
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "blocked", statusVersion: 0, issueMutationVersion: 0 });
  });

  it("denies unrelated execution policy fields on guarded observer updates", async () => {
    const seeded = await seedIssue("in_review");
    await request(seeded.app)
      .post(`/api/issues/${seeded.issueId}/guarded-status`)
      .send({
        operationId: "factory:observer:policy-stage",
        operationKind: "guarded_status_update",
        expectedStatus: "in_review",
        expectedStatusVersion: 0,
        expectedMutationVersion: 0,
        status: "in_review",
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [{
            type: "review",
            approvalsNeeded: 1,
            participants: [{ type: "user", userId: seeded.userId }],
          }],
        },
      })
      .expect(422);
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "in_review", statusVersion: 0, issueMutationVersion: 0 });
  });

  it("allows assigned standard agents to change monitors through guarded status updates", async () => {
    const seeded = await seedAgentIssue("in_review");
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "in_review", statusVersion: 0, issueMutationVersion: 1 });

    const monitorAllowed = await request(seeded.agentApp)
      .post(`/api/issues/${seeded.issueId}/guarded-status`)
      .send({
        operationId: "factory:observer:monitor-standard-assignee",
        operationKind: "guarded_status_update",
        expectedStatus: "in_review",
        expectedStatusVersion: 0,
        expectedMutationVersion: 1,
        status: "in_review",
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [],
          monitor: {
            kind: "external_service",
            nextCheckAt: "2026-09-06T12:00:00.000Z",
            serviceName: "Software Factory",
            externalRef: "chain:standard-assignee",
            scheduledBy: "assignee",
            maxAttempts: 6,
            recoveryPolicy: "wake_owner",
          },
        },
      });
    expect(monitorAllowed.status).toBe(200);
    expect(monitorAllowed.body).toMatchObject({ applied: true, issue: { status: "in_review" } });
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "in_review", statusVersion: 0, issueMutationVersion: 2 });
  });

  it("denies scoped task-bridge agents with stale runtime manage grants from guarded monitor changes", async () => {
    const seeded = await seedAgentIssue("in_review");
    const keyId = randomUUID();
    await ctx.db.insert(principalPermissionGrants).values({
      companyId: seeded.companyId,
      principalType: "agent",
      principalId: seeded.agentId,
      permissionKey: "runtime:manage",
      grantedByUserId: null,
    });
    const restrictedActor = {
      type: "agent",
      source: "agent_jwt",
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      keyId,
      keyScope: { kind: "task_bridge", parentIssueId: randomUUID() },
    };
    const restrictedApp = routeApp(ctx.db, restrictedActor as any, issueRoutes);
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "in_review", statusVersion: 0, issueMutationVersion: 1 });

    const monitorDenied = await request(restrictedApp)
      .post(`/api/issues/${seeded.issueId}/guarded-status`)
      .send({
        operationId: "factory:observer:monitor-task-bridge-stale-grant",
        operationKind: "guarded_status_update",
        expectedStatus: "in_review",
        expectedStatusVersion: 0,
        expectedMutationVersion: 1,
        status: "in_review",
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [],
          monitor: {
            kind: "external_service",
            nextCheckAt: "2026-09-06T12:00:00.000Z",
            serviceName: "Software Factory",
            externalRef: "chain:task-bridge-denied",
            scheduledBy: "assignee",
            maxAttempts: 6,
            recoveryPolicy: "wake_owner",
          },
        },
      });
    expect(monitorDenied.status).toBe(403);
    expect(monitorDenied.body).toMatchObject({ details: { reason: "deny_scope" } });
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "in_review", statusVersion: 0, issueMutationVersion: 1 });
  });

  it("denies unrelated agents from guarded source mutation during active recovery", async () => {
    const seeded = await seedAgentIssue("in_progress");
    const ownerAgentId = randomUUID();
    const unrelatedAgentId = randomUUID();
    await ctx.db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId: seeded.companyId,
        name: `owner-${ownerAgentId}`,
        role: "worker",
        title: "Recovery owner",
        capabilities: "",
        adapterType: "process",
        adapterConfig: {},
        permissions: {},
      },
      {
        id: unrelatedAgentId,
        companyId: seeded.companyId,
        name: `unrelated-${unrelatedAgentId}`,
        role: "worker",
        title: "Unrelated",
        capabilities: "",
        adapterType: "process",
        adapterConfig: {},
        permissions: {},
      },
    ]);
    await ctx.db.insert(issueRecoveryActions).values({
      companyId: seeded.companyId,
      sourceIssueId: seeded.issueId,
      kind: "safe_handoff",
      status: "active",
      ownerType: "agent",
      ownerAgentId,
      cause: "test_active_recovery",
      fingerprint: "guarded-source-mutation",
      evidence: {},
      nextAction: "wait",
    });
    const unrelatedActor = {
      type: "agent",
      source: "agent_jwt",
      agentId: unrelatedAgentId,
      companyId: seeded.companyId,
      runId: randomUUID(),
    };
    const unrelatedApp = routeApp(ctx.db, unrelatedActor as any, issueRoutes);

    const recoveryDenied = await request(unrelatedApp)
      .post(`/api/issues/${seeded.issueId}/guarded-status`)
      .send({
        operationId: "factory:observer:active-recovery-unrelated",
        operationKind: "guarded_status_update",
        expectedStatus: "in_progress",
        expectedStatusVersion: 0,
        expectedMutationVersion: 1,
        status: "blocked",
        comment: "Unrelated agent cannot mutate source while recovery is active.",
      });
    expect(recoveryDenied.status).toBe(409);
    await expect(readIssue(seeded.issueId)).resolves.toMatchObject({ status: "in_progress", statusVersion: 0, issueMutationVersion: 1 });
  });
});
