import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("web-push", () => ({ default: { sendNotification: vi.fn(async () => ({ statusCode: 201 })) } }));

import webpush from "web-push";
import { createVapidSender } from "../src/notifications/webpush.js";

describe("createVapidSender", () => {
  beforeEach(() => vi.mocked(webpush.sendNotification).mockClear());

  const vapid = { publicKey: "pub-".padEnd(24, "p"), privateKey: "priv-".padEnd(24, "k"), subject: "mailto:admin@example.com" };
  const target = { endpoint: "https://push.example.com/abc", keys: { p256dh: "P", auth: "A" } };

  it("sends the payload to the subscription signed with the VAPID keys, short-lived and high priority", async () => {
    await createVapidSender(vapid).send(target, '{"title":"x"}');
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(webpush.sendNotification).toHaveBeenCalledWith(target, '{"title":"x"}', {
      vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: 3600,
      urgency: "high",
      timeout: 10_000,
    });
  });

  it("lets the push service's error through so the caller can tell 'gone' (404/410) from a real failure", async () => {
    vi.mocked(webpush.sendNotification).mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }));
    await expect(createVapidSender(vapid).send(target, "{}")).rejects.toMatchObject({ statusCode: 410 });
  });
});
