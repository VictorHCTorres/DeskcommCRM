"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

interface Relation {
  id: string;
  relation_type: "linked" | "dependency";
  target: { kind: "task" | "lead"; id: string; title: string };
}

export function RelacoesClickUpDoLead({ leadId }: { leadId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [relations, setRelations] = useState<Relation[] | null>(null);
  const [error, setError] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || relations) return;
    setError(false);
    try {
      const response = await fetch(`/api/v1/leads/${leadId}/relations`);
      const body = (await response.json()) as { data?: { relations?: Relation[] } };
      if (!response.ok) throw new Error("relations_fetch_failed");
      setRelations(body.data?.relations ?? []);
    } catch {
      setError(true);
    }
  }

  return (
    <section
      className="border-t border-border py-3"
      aria-labelledby={`clickup-relations-${leadId}`}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        aria-expanded={open}
        onClick={() => void toggle()}
      >
        <span id={`clickup-relations-${leadId}`}>{t("Relações do ClickUp")}</span>
      </Button>
      {open ? (
        <div className="mt-1 rounded-md border bg-muted/20 p-2 text-xs" aria-live="polite">
          <p className="text-muted-foreground">{t("Vínculos importados — somente leitura.")}</p>
          {error ? <p role="alert">{t("Não foi possível carregar as relações.")}</p> : null}
          {relations?.length === 0 ? <p>{t("Nenhuma relação importada.")}</p> : null}
          <ul className="space-y-1">
            {relations?.map((relation) => (
              <li key={relation.id}>
                <Link
                  className="underline-offset-2 hover:underline focus-visible:underline"
                  href={
                    relation.target.kind === "lead"
                      ? `/app/leads/${relation.target.id}`
                      : "/app/tasks"
                  }
                >
                  {relation.relation_type === "dependency" ? t("Dependência") : t("Vinculada")}:{" "}
                  {relation.target.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
