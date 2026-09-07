import {
  foreignKey,
  index,
  jsonb,
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  bigint,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueComments } from "./issue_comments.js";

export const issueStatusOperations = pgTable(
  "issue_status_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull(),
    operationId: text("operation_id").notNull(),
    operationDigest: text("operation_digest").notNull(),
    operationKind: text("operation_kind").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    actorAgentId: uuid("actor_agent_id"),
    actorUserId: text("actor_user_id"),
    actorRunId: uuid("actor_run_id"),
    expectedStatus: text("expected_status").notNull(),
    expectedStatusVersion: bigint("expected_status_version", { mode: "number" }).notNull(),
    expectedMutationVersion: bigint("expected_mutation_version", { mode: "number" }).notNull(),
    requestedStatus: text("requested_status").notNull(),
    applied: boolean("applied").notNull(),
    statusBefore: text("status_before").notNull(),
    statusVersionBefore: bigint("status_version_before", { mode: "number" }).notNull(),
    mutationVersionBefore: bigint("mutation_version_before", { mode: "number" }).notNull(),
    statusAfter: text("status_after").notNull(),
    statusVersionAfter: bigint("status_version_after", { mode: "number" }).notNull(),
    mutationVersionAfter: bigint("mutation_version_after", { mode: "number" }).notNull(),
    commentId: uuid("comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    responseJson: jsonb("response_json").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueCompanyFk: foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "issue_status_operations_issue_company_fk",
    }),
    companyOperationUq: uniqueIndex("issue_status_operations_company_operation_uq").on(
      table.companyId,
      table.operationId,
    ),
    companyIssueCreatedIdx: index("issue_status_operations_company_issue_created_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
  }),
);
