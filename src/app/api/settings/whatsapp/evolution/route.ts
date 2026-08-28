import { z } from "zod";
import { parseBody, withAuth } from "@/lib/api";
import {
  getEvolutionCredentialsByOrg,
  saveEvolutionCredentials,
  tokenLast4,
} from "@/server/whatsapp/evolution-credentials";

export const dynamic = "force-dynamic";

export const GET = withAuth(async (session) => {
  const creds = await getEvolutionCredentialsByOrg(session.organizationId);
  if (!creds)
    return Response.json({
      connection: null,
    });
  return Response.json({
    connection: {
      instanceName: creds.instanceName,
      instanceId: creds.instanceId,
      jid: creds.jid,
      status: creds.status,
      tokenLast4: tokenLast4(creds.instanceToken),
    },
  });
});

const putSchema = z.object({
  instanceName: z.string().trim().min(1),
  instanceToken: z.string().trim().min(1),
});

export const PUT = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;

  await saveEvolutionCredentials({
    organizationId: session.organizationId,
    instanceName: body.data.instanceName,
    instanceToken: body.data.instanceToken,
  });

  return Response.json({ ok: true });
});
