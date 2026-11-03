"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { WebhookFormField } from "@/lib/webhooks/formulario";
import { CAMPO_ANTISPAM_FORMULARIO_PUBLICO } from "@/lib/webhooks/formulario-publico";
import { randomId } from "@/lib/random-id";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  nome: string;
  token: string;
  campos: WebhookFormField[];
}

type Estado = "pronto" | "enviando" | "sucesso" | "erro";

function Rotulo({
  htmlFor,
  children,
  obrigatorio = false,
  className,
}: {
  htmlFor: string;
  children: React.ReactNode;
  obrigatorio?: boolean;
  className?: string;
}) {
  return (
    <Label htmlFor={htmlFor} className={className}>
      {children}
      {obrigatorio ? (
        <>
          <span aria-hidden="true" className="text-destructive">
            {" "}
            *
          </span>
        </>
      ) : null}
    </Label>
  );
}

function CampoPersonalizado({ campo }: { campo: WebhookFormField }) {
  const t = useT();
  const id = `campo-${campo.key}`;
  const comum = { id, name: campo.key, required: campo.required };

  if (campo.type === "textarea") {
    return (
      <div className="space-y-2">
        <Rotulo htmlFor={id} obrigatorio={campo.required}>
          {campo.label}
        </Rotulo>
        <Textarea {...comum} rows={4} />
      </div>
    );
  }
  if (campo.type === "select") {
    return (
      <div className="space-y-2">
        <Rotulo htmlFor={id} obrigatorio={campo.required}>
          {campo.label}
        </Rotulo>
        <select
          {...comum}
          className="h-10 w-full rounded-sm border border-input bg-background px-3 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-ring"
          defaultValue=""
        >
          <option value="" disabled={campo.required}>
            {t("Selecione uma opção")}
          </option>
          {(campo.options ?? []).map((opcao) => (
            <option key={opcao} value={opcao}>
              {opcao}
            </option>
          ))}
        </select>
      </div>
    );
  }
  if (campo.type === "checkbox") {
    return (
      <div className="flex items-start gap-3">
        <input type="hidden" name={campo.key} value="false" />
        <input
          {...comum}
          type="checkbox"
          value="true"
          className="mt-1 size-4 rounded border-input accent-accent"
        />
        <Rotulo htmlFor={id} obrigatorio={campo.required} className="leading-5">
          {campo.label}
        </Rotulo>
      </div>
    );
  }

  const inputProps =
    campo.type === "number"
      ? { type: "text", inputMode: "decimal" as const, pattern: "-?[0-9]+([.][0-9]+)?" }
      : campo.type === "currency"
        ? { type: "text", inputMode: "decimal" as const, placeholder: "R$ 0,00" }
        : { type: "text" };
  return (
    <div className="space-y-2">
      <Rotulo htmlFor={id} obrigatorio={campo.required}>
        {campo.label}
      </Rotulo>
      <Input {...comum} {...inputProps} />
    </div>
  );
}

export function FormularioPublicoClient({ nome, token, campos }: Props) {
  const t = useT();
  const [estado, setEstado] = React.useState<Estado>("pronto");
  const [mensagem, setMensagem] = React.useState("");
  // O mesmo preenchimento conserva a identidade entre tentativas. Só um envio
  // aceito abre uma nova tentativa lógica; assim timeout/retry não cria dois
  // cards e "Enviar outra resposta" continua criando um cadastro novo.
  const externalId = React.useRef(randomId());

  const enviar = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setEstado("enviando");
    setMensagem("");

    const form = event.currentTarget;
    const payload = {
      ...Object.fromEntries(new FormData(form).entries()),
      external_id: externalId.current,
    };
    try {
      const response = await fetch(`/api/v1/webhooks/in/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(
          response.status === 429
            ? t("Muitas tentativas em pouco tempo. Aguarde um minuto e tente novamente.")
            : t("Não foi possível enviar agora. Confira os dados e tente novamente."),
        );
      }
      form.reset();
      externalId.current = randomId();
      setEstado("sucesso");
      setMensagem(t("Recebemos seus dados. A equipe poderá entrar em contato em breve."));
    } catch (error) {
      setEstado("erro");
      setMensagem(error instanceof Error ? error.message : t("Não foi possível enviar agora."));
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl items-center px-4 py-10 sm:px-6">
      <section className="w-full rounded-lg border border-border bg-card p-6 shadow-sm sm:p-8">
        <div className="mb-7 space-y-2">
          <p className="text-sm font-medium text-accent">{t("Entre em contato")}</p>
          <h1 className="text-2xl font-semibold tracking-tight text-text sm:text-3xl">{nome}</h1>
          <p className="text-sm text-muted-foreground">
            {t(
              "Preencha os dados abaixo. Os campos marcados como obrigatórios precisam ser respondidos.",
            )}
          </p>
        </div>

        {estado === "sucesso" ? (
          <div
            className="space-y-4 rounded-sm border border-success/30 bg-success/10 p-5"
            role="status"
          >
            <h2 className="text-lg font-semibold text-text">{t("Dados enviados")}</h2>
            <p className="text-sm text-muted-foreground">{mensagem}</p>
            <Button type="button" variant="secondary" onClick={() => setEstado("pronto")}>
              {t("Enviar outra resposta")}
            </Button>
          </div>
        ) : (
          <form className="space-y-5" onSubmit={enviar} noValidate={false}>
            <div
              aria-hidden="true"
              className="absolute top-auto -left-[10000px] size-px overflow-hidden"
            >
              <Label htmlFor="formulario-site">{t("Site")}</Label>
              <Input
                id="formulario-site"
                name={CAMPO_ANTISPAM_FORMULARIO_PUBLICO}
                type="text"
                tabIndex={-1}
                autoComplete="off"
              />
            </div>

            <div className="space-y-2">
              <Rotulo htmlFor="nome" obrigatorio>
                {t("Nome")}
              </Rotulo>
              <Input id="nome" name="nome" autoComplete="name" required />
            </div>
            <div className="space-y-2">
              <Rotulo htmlFor="telefone" obrigatorio>
                {t("WhatsApp")}
              </Rotulo>
              <Input
                id="telefone"
                name="telefone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">{t("E-mail")}</Label>
              <Input id="email" name="email" type="email" inputMode="email" autoComplete="email" />
            </div>

            {campos.map((campo) => (
              <CampoPersonalizado key={campo.key} campo={campo} />
            ))}

            {mensagem ? (
              <p
                className="rounded-sm border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                role="alert"
                aria-live="assertive"
              >
                {mensagem}
              </p>
            ) : null}

            <Button className="w-full" type="submit" disabled={estado === "enviando"}>
              {estado === "enviando" ? t("Enviando…") : t("Enviar dados")}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              {t("Seus dados serão usados para responder a este contato. Consulte a")}{" "}
              <a className="underline underline-offset-2" href="/legal/privacy">
                {t("Política de Privacidade")}
              </a>
              .
            </p>
          </form>
        )}
      </section>
    </main>
  );
}
