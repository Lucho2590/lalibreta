import "server-only";

import { adminAuth } from "./firebase-admin";

export interface AuthedUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export class UnauthorizedError extends Error {
  constructor(message = "No autorizado") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export const getAuthedUser = async (req: Request): Promise<AuthedUser> => {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    throw new UnauthorizedError("Falta header Authorization: Bearer <idToken>");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) throw new UnauthorizedError("Token vacío");

  try {
    const decoded = await adminAuth().verifyIdToken(token);
    return {
      uid: decoded.uid,
      email: decoded.email ?? null,
      emailVerified: decoded.email_verified ?? false,
      name: (decoded.name as string | undefined) ?? null,
      picture: (decoded.picture as string | undefined) ?? null,
    };
  } catch (err) {
    throw new UnauthorizedError(
      err instanceof Error ? `Token inválido: ${err.message}` : "Token inválido",
    );
  }
};

export const unauthorizedResponse = (message = "No autorizado") =>
  new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
