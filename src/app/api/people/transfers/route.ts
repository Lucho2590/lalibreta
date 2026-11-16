import { authedPost } from "@/lib/server/route";
import { PeopleError } from "@/lib/server/connections";
import { createPersonTransfer, type PersonTransferInput } from "@/lib/server/person-transfers";

export const runtime = "nodejs";

/** Registrar plata que le pasé a una persona o que me pasó. */
export const POST = authedPost<Partial<PersonTransferInput>>(async (user, body) => {
  if (!body.person || !body.accountId || !body.amount || (body.direction !== "in" && body.direction !== "out")) {
    throw new PeopleError("Faltan datos de la transferencia");
  }
  return createPersonTransfer(user, {
    person: body.person,
    direction: body.direction,
    accountId: body.accountId,
    amount: Number(body.amount),
    currency: body.currency === "USD" ? "USD" : "ARS",
    date: body.date,
    description: body.description,
    kind: body.kind === "loan" ? "loan" : "payment",
  });
});
