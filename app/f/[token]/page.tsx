import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { buscarFormularioPublico } from "@/lib/webhooks/formulario-publico";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";
import { FormularioPublicoClient } from "./_client";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const idioma = await idiomaDoVisitante(null);
  return {
    title: traduzir("Formulário de contato", idioma),
    robots: { index: false, follow: false },
  };
}

export default async function FormularioPublicoPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const formulario = await buscarFormularioPublico(token);
  if (!formulario) notFound();
  const idioma = await idiomaDoVisitante(null);

  return (
    <IdiomaProvider locale={idioma}>
      <FormularioPublicoClient
        nome={formulario.nome}
        token={formulario.token}
        campos={formulario.campos}
      />
    </IdiomaProvider>
  );
}
