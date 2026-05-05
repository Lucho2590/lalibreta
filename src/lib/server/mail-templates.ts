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
        <div style="font-size: 12px; letter-spacing: 1px; text-transform: uppercase; opacity: 0.8;">Saldo · Control de gastos</div>
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

export interface ShareInviteEmailParams {
  to: string;
  ownerName: string;
  ownerEmail: string;
  description: string;
  totalAmount: number;
  participantAmount: number;
  participantPercentage: number;
  date: Date;
  appUrl: string;
  sharedExpenseId: string;
  recipientIsRegistered: boolean;
}

export const renderShareInviteEmail = (p: ShareInviteEmailParams) => {
  const dateStr = new Intl.DateTimeFormat("es-AR", { dateStyle: "medium" }).format(p.date);
  const url = p.recipientIsRegistered
    ? `${p.appUrl}/compartidas/${p.sharedExpenseId}`
    : `${p.appUrl}/login?from=${encodeURIComponent(`/compartidas/${p.sharedExpenseId}`)}`;

  const subject = `${p.ownerName} compartió un gasto con vos`;
  const html = card(`
    <h2 style="margin: 0 0 12px; font-size: 20px;">Te compartieron un gasto</h2>
    <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #52525b;">
      <strong>${p.ownerName}</strong> (${p.ownerEmail}) cargó un gasto y quiere dividirlo con vos.
    </p>
    <div style="background: #f4f4f5; border-radius: 16px; padding: 16px; margin-bottom: 20px;">
      <div style="font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px;">${p.description || "Gasto"}</div>
      <div style="font-size: 24px; font-weight: 700; margin-top: 4px;">${formatARS(p.totalAmount)}</div>
      <div style="font-size: 12px; color: #71717a; margin-top: 4px;">${dateStr}</div>
    </div>
    <div style="background: #ede9fe; border-radius: 16px; padding: 16px; margin-bottom: 20px;">
      <div style="font-size: 12px; color: #6d4ce0; text-transform: uppercase; letter-spacing: 0.5px;">Te toca</div>
      <div style="font-size: 22px; font-weight: 700; color: #5236bd; margin-top: 4px;">${formatARS(p.participantAmount)}</div>
      <div style="font-size: 12px; color: #6d4ce0; margin-top: 4px;">${p.participantPercentage}% del total</div>
    </div>
    <p style="margin: 0 0 16px; font-size: 14px; color: #52525b;">
      ${p.recipientIsRegistered
        ? "Entrá a la app para aceptar o rechazar el gasto."
        : "Todavía no estás registrado. Creá tu cuenta y vas a ver el gasto compartido para aceptarlo o rechazarlo."}
    </p>
    ${button(url, p.recipientIsRegistered ? "Ver gasto" : "Crear cuenta y ver el gasto")}
  `);

  const text = [
    `${p.ownerName} (${p.ownerEmail}) cargó un gasto y quiere dividirlo con vos.`,
    ``,
    `${p.description || "Gasto"} — ${formatARS(p.totalAmount)} · ${dateStr}`,
    `Te toca: ${formatARS(p.participantAmount)} (${p.participantPercentage}%)`,
    ``,
    `Abrí: ${url}`,
  ].join("\n");

  return { subject, html, text };
};

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

export interface ShareResponseEmailParams {
  to: string;
  responderName: string;
  responderEmail: string;
  response: "accepted" | "rejected";
  description: string;
  totalAmount: number;
  responderAmount: number;
  appUrl: string;
  sharedExpenseId: string;
}

export const renderShareResponseEmail = (p: ShareResponseEmailParams) => {
  const verb = p.response === "accepted" ? "aceptó" : "rechazó";
  const subject = `${p.responderName} ${verb} tu gasto compartido`;
  const url = `${p.appUrl}/compartidas/${p.sharedExpenseId}`;
  const html = card(`
    <h2 style="margin: 0 0 12px; font-size: 20px;">Gasto compartido ${verb === "aceptó" ? "aceptado" : "rechazado"}</h2>
    <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #52525b;">
      <strong>${p.responderName}</strong> (${p.responderEmail}) ${verb} el gasto que compartiste.
    </p>
    <div style="background: #f4f4f5; border-radius: 16px; padding: 16px; margin-bottom: 20px;">
      <div style="font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px;">${p.description || "Gasto"}</div>
      <div style="font-size: 22px; font-weight: 700; margin-top: 4px;">${formatARS(p.totalAmount)}</div>
      <div style="font-size: 12px; color: #71717a; margin-top: 4px;">Su parte: ${formatARS(p.responderAmount)}</div>
    </div>
    ${button(url, "Ver detalles")}
  `);
  const text = `${p.responderName} ${verb} el gasto compartido (${formatARS(p.totalAmount)}). Su parte: ${formatARS(p.responderAmount)}. Abrí: ${url}`;
  return { subject, html, text };
};
