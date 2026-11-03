import { describe, expect, it } from "vitest";

import {
  CLICKUP_DOC_CONTENT_BLOCK_REASON,
  blockForMissingDocumentContent,
  clickupConnectionReceiptIdentity,
  clickupExecuteSchema,
  clickupManifestSchema,
  clickupMappingSchema,
} from "@/lib/clickup/contrato";
import { fingerprintClickUpTokenForIdempotency } from "@/lib/clickup/crypto";
import { hashDoCorpo } from "@/lib/api/idempotency";
import {
  canonicalizeClickUpManifest,
  discoveredObjectToStaging,
  manifestHash,
} from "@/lib/clickup/manifest";
import { CLICKUP_ITEM_SAFE_COLUMNS, CLICKUP_RUN_SAFE_COLUMNS } from "@/lib/clickup/store";

const CONNECTION = "90950000-0000-4000-8000-000000000001";

describe("contrato do envelope ClickUp", () => {
  it("canonicaliza a ordem e produz snapshot hash estável", () => {
    const one = canonicalizeClickUpManifest({
      connection_id: CONNECTION,
      workspace_id: "wk-1",
      objects: [
        { source_type: "task", source_id: "2", metadata: { b: 2, a: 1 } },
        { source_type: "space", source_id: "1", metadata: {} },
      ],
    });
    const two = canonicalizeClickUpManifest({
      connection_id: CONNECTION,
      workspace_id: "wk-1",
      objects: [
        { source_type: "space", source_id: "1", metadata: {} },
        { source_type: "task", source_id: "2", metadata: { a: 1, b: 2 } },
      ],
    });
    expect(manifestHash(one)).toBe(manifestHash(two));
    expect(one.objects.map((item) => item.source_type)).toEqual(["space", "task"]);
  });

  it("usa hash semântico estável para relação observada em um ou nos dois lados", () => {
    const base = {
      source_type: "task_relation" as const,
      source_id: "linked:a:b",
      content_access: "none" as const,
      metadata: {
        relation_type: "linked",
        source_task_id: "a",
        target_task_id: "b",
      },
    };
    const unilateral = discoveredObjectToStaging({
      ...base,
      source_revision: "rev-1",
      metadata: { ...base.metadata, provenance: { raw_occurrences: 1, observed_from: ["a"] } },
    });
    const bilateralInvertido = discoveredObjectToStaging({
      ...base,
      source_revision: "rev-2",
      metadata: { ...base.metadata, provenance: { raw_occurrences: 2, observed_from: ["b", "a"] } },
    });
    expect(bilateralInvertido.source_hash).toBe(unilateral.source_hash);
  });

  it("recusa identidade duplicada e relação com endpoint fora do snapshot", () => {
    const duplicate = clickupManifestSchema.safeParse({
      connection_id: CONNECTION,
      workspace_id: "wk",
      objects: [
        { source_type: "task", source_id: "a", metadata: {} },
        { source_type: "task", source_id: "a", metadata: {} },
      ],
    });
    expect(duplicate.success).toBe(false);
    const dangling = clickupManifestSchema.safeParse({
      connection_id: CONNECTION,
      workspace_id: "wk",
      objects: [
        { source_type: "task", source_id: "a", metadata: {} },
        {
          source_type: "task_relation",
          source_id: "linked:a:b",
          metadata: { relation_type: "linked", source_task_id: "a", target_task_id: "b" },
        },
      ],
    });
    expect(dangling.success).toBe(false);
  });

  it("aceita o volume real de 5.813 objetos e preserva o teto de 10 mil", () => {
    const objects = Array.from({ length: 5_813 }, (_, index) => ({
      source_type: "task" as const,
      source_id: `task-${index}`,
      metadata: {},
    }));
    expect(
      clickupManifestSchema.safeParse({
        connection_id: CONNECTION,
        workspace_id: "wk-volume-real",
        objects,
      }).success,
    ).toBe(true);
    expect(
      clickupManifestSchema.safeParse({
        connection_id: CONNECTION,
        workspace_id: "wk-acima-do-teto",
        objects: Array.from({ length: 10_001 }, (_, index) => ({
          source_type: "task" as const,
          source_id: `overflow-${index}`,
          metadata: {},
        })),
      }).success,
    ).toBe(false);
  });

  it("bloqueia metadado de Docs sem conteúdo autorizado", () => {
    const object = {
      source_type: "doc" as const,
      source_id: "doc-1",
      metadata: { name: "Manual" },
      content_access: "metadata_only" as const,
    };
    expect(blockForMissingDocumentContent(object)).toEqual({
      execution_blocked: true,
      blocked_reason: CLICKUP_DOC_CONTENT_BLOCK_REASON,
    });
    expect(discoveredObjectToStaging(object).status).toBe("blocked");
    expect(
      clickupManifestSchema.safeParse({
        connection_id: CONNECTION,
        workspace_id: "wk-1",
        scope: "docs",
        objects: [
          {
            source_type: "doc",
            source_id: "doc-full-sem-conteudo",
            metadata: {},
            content_access: "full",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      clickupManifestSchema.safeParse({
        connection_id: CONNECTION,
        workspace_id: "wk-1",
        scope: "docs",
        objects: [
          {
            source_type: "doc_page",
            source_id: "page-full",
            metadata: {},
            content_access: "full",
            payload: { format: "markdown", content: "Conteúdo autorizado" },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("execute W3.1 aceita apply real, mas mantém CAS completo obrigatório", () => {
    const base = {
      expected_preview_revision: 1,
      expected_snapshot_hash: "a".repeat(64),
      expected_mapping_hash: null,
    };
    expect(clickupExecuteSchema.safeParse({ ...base, dry_run: true }).success).toBe(true);
    expect(
      clickupExecuteSchema.safeParse({
        ...base,
        dry_run: false,
        expected_mapping_hash: "b".repeat(64),
      }).success,
    ).toBe(true);
    expect(clickupExecuteSchema.safeParse({ ...base, dry_run: false }).success).toBe(false);
    expect(
      clickupExecuteSchema.safeParse({
        expected_preview_revision: 1,
        expected_mapping_hash: null,
      }).success,
    ).toBe(false);
  });

  it("payload temporário recebe expiração exata de no máximo 30 dias", () => {
    const now = new Date("2026-11-02T12:00:00.000Z");
    const row = discoveredObjectToStaging(
      {
        source_type: "task",
        source_id: "task-1",
        metadata: {},
        payload: { id: "task-1", description: "staging" },
        content_access: "none",
      },
      now,
    );
    expect(row.payload_expires_at).toBe("2026-12-02T12:00:00.000Z");
  });

  it("recusa matriz entidade→alvo e field_key fora do contrato real", () => {
    expect(
      clickupMappingSchema.safeParse({
        expected_revision: 0,
        mapping: {
          objects: [
            {
              entity_type: "list",
              external_id: "list-1",
              target: { kind: "stage", stage_id: CONNECTION },
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      clickupMappingSchema.safeParse({
        expected_revision: 0,
        mapping: {
          objects: [
            {
              entity_type: "custom_field",
              external_id: "field-1",
              target: {
                kind: "custom_field",
                pipeline_id: CONNECTION,
                field_key: "campo-com-hifen",
              },
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("idempotência usa fingerprint HMAC: replay do mesmo token e conflito do diferente", () => {
    const tokenA = fingerprintClickUpTokenForIdempotency("pk_token_a", "segredo-de-teste");
    const replayA = fingerprintClickUpTokenForIdempotency("pk_token_a", "segredo-de-teste");
    const tokenB = fingerprintClickUpTokenForIdempotency("pk_token_b", "segredo-de-teste");
    expect(tokenA).toBe(replayA);
    expect(tokenB).not.toBe(tokenA);
    expect(tokenA).not.toContain("pk_token_a");
    const identityA = clickupConnectionReceiptIdentity(
      { workspace_id: "wk-1", workspace_name: "Workspace" },
      tokenA,
    );
    const replayIdentityA = clickupConnectionReceiptIdentity(
      { workspace_id: "wk-1", workspace_name: "Workspace" },
      replayA,
    );
    const identityB = clickupConnectionReceiptIdentity(
      { workspace_id: "wk-1", workspace_name: "Workspace" },
      tokenB,
    );
    expect(identityA).toEqual({
      workspace_id: "wk-1",
      workspace_name: "Workspace",
      token_fingerprint: tokenA,
    });
    expect(hashDoCorpo(replayIdentityA)).toBe(hashDoCorpo(identityA));
    expect(hashDoCorpo(identityB)).not.toBe(hashDoCorpo(identityA));
  });

  it("projeções HTTP não carregam lease, configuração interna ou payload bruto", () => {
    expect(CLICKUP_RUN_SAFE_COLUMNS).not.toMatch(
      /lease_owner|lease_token|lease_expires_at|heartbeat_at|mapping_config/,
    );
    expect(CLICKUP_ITEM_SAFE_COLUMNS).not.toMatch(
      /source_payload|claim_token|claimed_until|payload_expires_at/,
    );
  });
});
