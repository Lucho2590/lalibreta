import "server-only";

const formatARS = (n: number) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 2,
  }).format(n);

const baseStyles = `
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #f5f5f7;
  color: #18181b;
  padding: 24px;
  margin: 0;
`;

const card = (body: string) => `
  <div style="${baseStyles}">
    <div style="max-width: 520px; margin: 0 auto; background: white; border-radius: 24px; overflow: hidden; border: 1px solid #e5e5e8;">
      <div style="background: linear-gradient(135deg, #6d4ce0 0%, #5236bd 100%); color: white; padding: 28px 24px;">
        <div style="font-size: 12px; letter-spacing: 1px; text-transform: uppercase; opacity: 0.8;">La Libreta · Control de gastos</div>
      </div>
      <div style="padding: 24px;">
        ${body}
      </div>
    </div>
    <p style="text-align: center; margin-top: 16px; font-size: 11px; color: #71717a;">
      Si no esperabas este mail, podés ignorarlo.
    </p>
  </div>
`;

const button = (href: string, label: string) => `
  <a href="${href}" style="display: inline-block; background: linear-gradient(135deg, #6d4ce0 0%, #5236bd 100%); color: white; text-decoration: none; padding: 12px 20px; border-radius: 12px; font-weight: 600; font-size: 14px;">${label}</a>
`;

export interface AccountShareEmailParams {
  to: string;
  ownerName: string;
  ownerEmail: string;
  accountName: string;
  appUrl: string;
  recipientIsRegistered: boolean;
}

export const renderAccountShareEmail = (p: AccountShareEmailParams) => {
  const url = p.recipientIsRegistered
    ? `${p.appUrl}/cuentas`
    : `${p.appUrl}/login?from=${encodeURIComponent("/cuentas")}`;
  const subject = `${p.ownerName} te dio acceso a su cuenta "${p.accountName}"`;
  const html = card(`
    <h2 style="margin: 0 0 12px; font-size: 20px;">Te compartieron una cuenta</h2>
    <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #52525b;">
      <strong>${p.ownerName}</strong> (${p.ownerEmail}) te dio permiso para cargar gastos en su cuenta <strong>${p.accountName}</strong>.
    </p>
    <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #52525b;">
      Cualquier gasto que cargues va a quedar pendiente de aprobación por el dueño antes de impactar.
    </p>
    ${button(url, p.recipientIsRegistered ? "Ver mis cuentas" : "Crear cuenta y entrar")}
  `);
  const text = `${p.ownerName} te dio acceso a su cuenta "${p.accountName}". Los gastos que cargues quedan pendientes de aprobación. Abrí: ${url}`;
  return { subject, html, text };
};

export interface PendingApprovalSubmittedEmailParams {
  to: string;
  granteeName: string;
  granteeEmail: string;
  accountName: string;
  description: string;
  totalAmount: number;
  installments: number;
  date: Date;
  appUrl: string;
}

export const renderPendingApprovalSubmittedEmail = (
  p: PendingApprovalSubmittedEmailParams,
) => {
  const dateStr = new Intl.DateTimeFormat("es-AR", { dateStyle: "medium" }).format(p.date);
  const url = `${p.appUrl}/aprobaciones`;
  const subject = `${p.granteeName} cargó un gasto en "${p.accountName}"`;
  const html = card(`
    <h2 style="margin: 0 0 12px; font-size: 20px;">Tenés un gasto para aprobar</h2>
    <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #52525b;">
      <strong>${p.granteeName}</strong> (${p.granteeEmail}) cargó un gasto en tu cuenta <strong>${p.accountName}</strong> y necesita tu aprobación.
    </p>
    <div style="background: #f4f4f5; border-radius: 16px; padding: 16px; margin-bottom: 20px;">
      <div style="font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px;">${p.description || "Gasto"}</div>
      <div style="font-size: 24px; font-weight: 700; margin-top: 4px;">${formatARS(p.totalAmount)}</div>
      <div style="font-size: 12px; color: #71717a; margin-top: 4px;">${dateStr}${p.installments > 1 ? ` · ${p.installments} cuotas` : ""}</div>
    </div>
    ${button(url, "Revisar y aprobar")}
  `);
  const text = `${p.granteeName} cargó un gasto en "${p.accountName}": ${formatARS(p.totalAmount)} · ${dateStr}. Revisá: ${url}`;
  return { subject, html, text };
};

export interface ApprovalDecisionEmailParams {
  to: string;
  ownerName: string;
  decision: "approved" | "rejected";
  accountName: string;
  description: string;
  totalAmount: number;
  rejectReason?: string | null;
  appUrl: string;
}

export const renderApprovalDecisionEmail = (p: ApprovalDecisionEmailParams) => {
  const verb = p.decision === "approved" ? "aprobó" : "rechazó";
  const subject = `${p.ownerName} ${verb} tu gasto en "${p.accountName}"`;
  const url = `${p.appUrl}/cuentas`;
  const html = card(`
    <h2 style="margin: 0 0 12px; font-size: 20px;">Gasto ${p.decision === "approved" ? "aprobado" : "rechazado"}</h2>
    <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #52525b;">
      <strong>${p.ownerName}</strong> ${verb} el gasto que cargaste en <strong>${p.accountName}</strong>.
    </p>
    <div style="background: #f4f4f5; border-radius: 16px; padding: 16px; margin-bottom: 20px;">
      <div style="font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px;">${p.description || "Gasto"}</div>
      <div style="font-size: 22px; font-weight: 700; margin-top: 4px;">${formatARS(p.totalAmount)}</div>
      ${
        p.decision === "rejected" && p.rejectReason
          ? `<div style="margin-top: 8px; font-size: 12px; color: #71717a;">Motivo: ${p.rejectReason}</div>`
          : ""
      }
    </div>
    ${button(url, "Ir a la app")}
  `);
  const text = `${p.ownerName} ${verb} el gasto: ${p.description || "(sin descripción)"} — ${formatARS(p.totalAmount)}. Abrí: ${url}`;
  return { subject, html, text };
};

export interface ActivityInviteEmailParams {
  ownerName: string;
  ownerEmail: string;
  title: string;
  /** "Sábado 22 de noviembre a las 20:00" */
  when: string;
  location: string | null;
  notes: string | null;
  estimated: string | null;
  appUrl: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Invitación a una actividad de la agenda para alguien que todavía no tiene cuenta. */
export const renderActivityInviteEmail = (p: ActivityInviteEmailParams) => {
  const url = `${p.appUrl}/login?from=${encodeURIComponent("/agenda")}`;
  const owner = escapeHtml(p.ownerName);
  const title = escapeHtml(p.title);
  const subject = `${p.ownerName} te invitó: ${p.title}`;
  const html = card(`
    <h2 style="margin: 0 0 12px; font-size: 20px;">Te invitaron a algo</h2>
    <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #52525b;">
      <strong>${owner}</strong> (${escapeHtml(p.ownerEmail)}) te sumó a una actividad de su agenda.
    </p>
    <div style="background: #f4f4f5; border-radius: 16px; padding: 16px; margin-bottom: 20px;">
      <div style="font-size: 20px; font-weight: 700;">${title}</div>
      <div style="font-size: 14px; color: #52525b; margin-top: 6px;">📅 ${escapeHtml(p.when)}</div>
      ${p.location ? `<div style="font-size: 14px; color: #52525b; margin-top: 4px;">📍 ${escapeHtml(p.location)}</div>` : ""}
      ${p.estimated ? `<div style="font-size: 14px; color: #52525b; margin-top: 4px;">💸 Gasto estimado: ${escapeHtml(p.estimated)}</div>` : ""}
      ${p.notes ? `<div style="font-size: 13px; color: #71717a; margin-top: 10px;">${escapeHtml(p.notes)}</div>` : ""}
    </div>
    <p style="margin: 0 0 16px; font-size: 14px; color: #52525b;">
      Creá tu cuenta en La Libreta con este mail para verla en tu agenda, decir si vas y cargar lo que gastes.
    </p>
    ${button(url, "Ver la invitación")}
  `);
  const text = [
    `${p.ownerName} (${p.ownerEmail}) te sumó a una actividad de su agenda.`,
    ``,
    `${p.title} — ${p.when}`,
    ...(p.location ? [`Lugar: ${p.location}`] : []),
    ...(p.estimated ? [`Gasto estimado: ${p.estimated}`] : []),
    ...(p.notes ? [``, p.notes] : []),
    ``,
    `Abrí: ${url}`,
  ].join("\n");
  return { subject, html, text };
};

export interface ActivityNoticeEmailParams {
  subject: string;
  heading: string;
  /** Renglones de texto plano (se escapan). */
  lines: string[];
  appUrl: string;
}

/** Aviso a un invitado sin cuenta: se canceló o cambió una actividad. */
export const renderActivityNoticeEmail = (p: ActivityNoticeEmailParams) => {
  const url = `${p.appUrl}/login?from=${encodeURIComponent("/agenda")}`;
  const html = card(`
    <h2 style="margin: 0 0 12px; font-size: 20px;">${escapeHtml(p.heading)}</h2>
    ${p.lines
      .map((l) => `<p style="margin: 0 0 10px; font-size: 14px; line-height: 1.5; color: #52525b;">${escapeHtml(l)}</p>`)
      .join("")}
    <div style="margin-top: 16px;">${button(url, "Ver la agenda")}</div>
  `);
  const text = [p.heading, "", ...p.lines, "", `Abrí: ${url}`].join("\n");
  return { subject: p.subject, html, text };
};
