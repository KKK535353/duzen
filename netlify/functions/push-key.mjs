import { store, vapid } from "../lib/push.mjs";

export default async () => {
  const v = await vapid(store());
  return Response.json({ publicKey: v.publicKey });
};

export const config = { path: "/api/push-key" };
