import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { buscarFormularioPublico } from "@/lib/webhooks/formulario-publico";
import { FormularioPublicoClient } from "./_client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Formulário de contato",
  robots: { index: false, follow: false },
};

export default async function FormularioPublicoPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const formulario = await buscarFormularioPublico(token);
  if (!formulario) notFound();

  return (
    <FormularioPublicoClient
      nome={formulario.nome}
      token={formulario.token}
      campos={formulario.campos}
    />
  );
}
