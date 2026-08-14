import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (!process.env.CLOUDFLARE_API_TOKEN) {
  console.log(
    JSON.stringify({
      event: "cloudflare_live_qualification_skipped",
      reason: "credentials_missing",
    }),
  );
  process.exit(0);
}

const requiredScope = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "MAIL_EDGE_CLOUDFLARE_ZONE_DOMAIN",
  "MAIL_EDGE_CLOUDFLARE_LIVE_DOMAIN",
  "MAIL_EDGE_CLOUDFLARE_LIVE_FROM",
  "MAIL_EDGE_CLOUDFLARE_LIVE_RECIPIENT",
  "MAIL_EDGE_CLOUDFLARE_EVENT_SUBSCRIPTION_ID",
  "MAIL_EDGE_CLOUDFLARE_EVENT_SUBSCRIPTION_NAME",
  "MAIL_EDGE_CLOUDFLARE_FEEDBACK_DLQ",
  "MAIL_EDGE_CLOUDFLARE_FEEDBACK_QUEUE_ID",
  "MAIL_EDGE_CLOUDFLARE_QUEUE_MAX_CONCURRENCY",
  "MAIL_EDGE_CLOUDFLARE_SENDING_QUOTA",
  "MAIL_EDGE_CLOUDFLARE_WORKER_NAME",
];
for (const name of requiredScope)
  assert.equal(typeof process.env[name], "string", `${name} required`);

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const zoneId = process.env.CLOUDFLARE_ZONE_ID;
const zoneDomain = process.env.MAIL_EDGE_CLOUDFLARE_ZONE_DOMAIN;
const domain = process.env.MAIL_EDGE_CLOUDFLARE_LIVE_DOMAIN;
const sender = process.env.MAIL_EDGE_CLOUDFLARE_LIVE_FROM;
const recipient = process.env.MAIL_EDGE_CLOUDFLARE_LIVE_RECIPIENT;
const eventSubscriptionId = process.env.MAIL_EDGE_CLOUDFLARE_EVENT_SUBSCRIPTION_ID;
const eventSubscriptionName = process.env.MAIL_EDGE_CLOUDFLARE_EVENT_SUBSCRIPTION_NAME;
const feedbackDlq = process.env.MAIL_EDGE_CLOUDFLARE_FEEDBACK_DLQ;
const feedbackQueueId = process.env.MAIL_EDGE_CLOUDFLARE_FEEDBACK_QUEUE_ID;
const queueMaxConcurrencyText = process.env.MAIL_EDGE_CLOUDFLARE_QUEUE_MAX_CONCURRENCY;
const sendingQuotaText = process.env.MAIL_EDGE_CLOUDFLARE_SENDING_QUOTA;
const workerName = process.env.MAIL_EDGE_CLOUDFLARE_WORKER_NAME;
assert.equal(typeof token, "string");
assert.equal(typeof accountId, "string");
assert.equal(typeof zoneId, "string");
assert.equal(typeof zoneDomain, "string");
assert.equal(typeof domain, "string");
assert.equal(typeof sender, "string");
assert.equal(typeof recipient, "string");
assert.equal(typeof eventSubscriptionId, "string");
assert.equal(typeof eventSubscriptionName, "string");
assert.equal(typeof feedbackDlq, "string");
assert.equal(typeof feedbackQueueId, "string");
assert.equal(typeof queueMaxConcurrencyText, "string");
assert.equal(typeof sendingQuotaText, "string");
assert.equal(typeof workerName, "string");
assert.match(accountId, /^[0-9a-f]{32}$/u);
assert.match(zoneId, /^[0-9a-f]{32}$/u);
assert.match(eventSubscriptionId, /^[0-9a-f]{32}$/u);
assert.match(feedbackQueueId, /^[0-9a-f]{32}$/u);
assert.match(eventSubscriptionName, /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,127}$/u);
assert.match(feedbackDlq, /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/u);
assert.match(workerName, /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/u);
const queueMaxConcurrency = Number(queueMaxConcurrencyText);
const sendingQuota = Number(sendingQuotaText);
assert.equal(Number.isSafeInteger(queueMaxConcurrency) && queueMaxConcurrency > 0, true);
assert.equal(Number.isSafeInteger(sendingQuota) && sendingQuota > 0, true);
assert.match(
  zoneDomain,
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u,
);
assert.equal(domain === zoneDomain || domain.endsWith(`.${zoneDomain}`), true);
assert.notEqual(
  domain,
  zoneDomain,
  "live qualification requires a sending subdomain because public apex onboarding/DNS discovery is unavailable",
);
assert.equal(sender.endsWith(`@${domain}`), true);

const request = async (path, init = {}) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...init.headers,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    assert.fail("redirect rejected");
  }
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of response.body ?? []) {
    byteLength += chunk.byteLength;
    assert.equal(byteLength <= 4 * 1024 * 1024, true, "Cloudflare response exceeded bound");
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks, byteLength).toString("utf8"));
  assert.equal(response.ok, true, `Cloudflare API status ${String(response.status)}`);
  assert.equal(body.success, true, "Cloudflare API success envelope required");
  return { result: body.result, resultInfo: body.result_info };
};

const { result: routing } = await request(`/zones/${zoneId}/email/routing`);
assert.equal(routing.enabled, true, "Email Routing must be enabled");
assert.equal(routing.status, "ready", "Email Routing status must be ready");
const { result: routingDns } = await request(`/zones/${zoneId}/email/routing/dns`);
assert.deepEqual(routingDns.errors, [], "Email Routing DNS must have no errors");
assert.equal(Array.isArray(routingDns.record) && routingDns.record.length > 0, true);

const { result: catchAll } = await request(`/zones/${zoneId}/email/routing/rules/catch_all`);
assert.equal(catchAll.enabled, true, "Email Routing catch-all must be enabled");
assert.equal(catchAll.source, "api", "Email Routing catch-all must be API-managed");
assert.deepEqual(catchAll.matchers, [{ type: "all" }], "catch-all matcher must be exact");
assert.deepEqual(
  catchAll.actions,
  [{ type: "worker", value: [workerName] }],
  "catch-all Worker target must be exact",
);

const { result: subdomains, resultInfo } = await request(
  `/zones/${zoneId}/email/sending/subdomains?page=1&per_page=100`,
);
assert.equal(resultInfo?.total_pages, 1, "sending subdomain pagination must be complete");
const matchingDomains = subdomains.filter((item) => item.name === domain);
assert.equal(matchingDomains.length, 1, "one exact sending subdomain is required");
const sendingDomain = matchingDomains[0];
assert.equal(sendingDomain.enabled, true, "sending subdomain must be enabled");
assert.match(sendingDomain.tag, /^[0-9a-f]{32}$/u);
const { result: expectedDns, resultInfo: dnsResultInfo } = await request(
  `/zones/${zoneId}/email/sending/subdomains/${sendingDomain.tag}/dns?page=1&per_page=100`,
);
assert.equal(dnsResultInfo?.total_pages, 1, "expected DNS pagination must be complete");
assert.equal(Array.isArray(expectedDns) && expectedDns.length > 0, true);
for (const record of expectedDns) {
  const expectedName = record.name === "@" ? zoneDomain : record.name.toLowerCase();
  const query = new URLSearchParams({
    content: record.content,
    name: expectedName,
    page: "1",
    per_page: "100",
    type: record.type,
  });
  const { result: actualDns, resultInfo: actualDnsInfo } = await request(
    `/zones/${zoneId}/dns_records?${query.toString()}`,
  );
  assert.equal(actualDnsInfo?.total_pages, 1, "actual DNS pagination must be complete");
  assert.equal(
    actualDns.some(
      (actual) =>
        actual.name.toLowerCase() === expectedName &&
        actual.type === record.type &&
        actual.content === record.content &&
        (record.type !== "MX" || actual.priority === record.priority),
    ),
    true,
    "exact sending DNS record missing",
  );
}

const { result: subscriptions, resultInfo: subscriptionResultInfo } = await request(
  `/accounts/${accountId}/event_subscriptions/subscriptions?page=1&per_page=100`,
);
assert.equal(subscriptionResultInfo?.total_pages, 1, "subscription pagination must be complete");
assert.equal(Array.isArray(subscriptions), true, "event subscription list required");
const matchingSubscriptions = subscriptions.filter(
  (subscription) => subscription.name === eventSubscriptionName,
);
assert.equal(matchingSubscriptions.length, 1, "one named event subscription is required");
const subscription = matchingSubscriptions[0];
assert.equal(subscription.id, eventSubscriptionId);
assert.equal(subscription.enabled, true);
assert.deepEqual(subscription.source, {
  domain,
  type: "email.sending",
  zone_id: zoneId,
});
assert.deepEqual(subscription.destination, {
  queue_id: feedbackQueueId,
  type: "queues.queue",
});
assert.deepEqual([...subscription.events].toSorted(), [
  "message.bounced",
  "message.complained",
  "message.deferred",
  "message.delivered",
  "message.failed",
  "message.rejected",
]);

const { result: queue } = await request(`/accounts/${accountId}/queues/${feedbackQueueId}`);
assert.equal(
  queue.consumers_total_count,
  queue.consumers.length,
  "queue consumers must be complete",
);
const workerConsumers = queue.consumers.filter(
  (consumer) => consumer.type === "worker" && consumer.script_name === workerName,
);
assert.equal(workerConsumers.length, 1, "one exact Worker Queue consumer is required");
const queueConsumer = workerConsumers[0];
assert.equal(queueConsumer.dead_letter_queue, feedbackDlq, "Queue DLQ must be exact");
assert.equal(queueConsumer.settings?.batch_size, 100);
assert.equal(queueConsumer.settings?.max_concurrency, queueMaxConcurrency);
assert.equal(queueConsumer.settings?.max_retries, 5);
assert.equal(queueConsumer.settings?.max_wait_time_ms, 5_000);
assert.equal(queueConsumer.settings?.retry_delay, 30);

const messageId = randomUUID();
const mime = [
  `From: ${sender}`,
  `To: ${recipient}`,
  "Subject: Mail Edge Cloudflare live qualification",
  `Message-ID: <${messageId}@${domain}>`,
  "Auto-Submitted: auto-generated",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: 7bit",
  "",
  `Mail Edge live qualification ${messageId}`,
  "",
].join("\r\n");
const { result: sent } = await request(`/accounts/${accountId}/email/sending/send_raw`, {
  body: JSON.stringify({ from: sender, mime_message: mime, recipients: [recipient] }),
  headers: { "Content-Type": "application/json" },
  method: "POST",
});
assert.equal(typeof sent.message_id, "string");
const outcomes = [...sent.delivered, ...sent.queued, ...sent.permanent_bounces];
assert.deepEqual(outcomes, [recipient], "recipient result must be an exact partition");
assert.deepEqual(sent.permanent_bounces, [], "qualification recipient must not permanently bounce");

console.log(
  JSON.stringify({
    event: "cloudflare_live_qualification_passed",
    messageId: sent.message_id,
    sendingQuota,
  }),
);
