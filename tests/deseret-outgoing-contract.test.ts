// HTTP side of outgoing delivery: how a Deseret answer becomes a coded error the worker can act on, and the signed
// receipt lookup for an event whose acknowledgement was lost. Contract with Deseret (2026-11-21):
//   POST /api/integrations/aigc/events/receipt, same service authentication, x-lw-request-id = eventId,
//   JSON {eventId, projectId, bodySha256}. 200 {accepted:true, eventId, status:"received"} only when project,
//   event and the SHA-256 of the exact original bytes all match; otherwise 404.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as contract from "../lib/deseret-integration-contract";

const config = { enabled: true, peerBaseUrl: "https://deseret.example.test/", allowLoopbackHttp: false, outgoingKeyId: "aigc-out", outgoingSecret: "s".repeat(40) };
const EVENT = "0b9e2c8e-5f0a-4c55-9a43-7d2b7f4f1a10";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const rejectsWith = (promise: Promise<unknown>, expected: Record<string, unknown>) => assert.rejects(promise, (error: unknown) => {
  for (const [key, value] of Object.entries(expected)) assert.equal((error as Record<string, unknown>)[key], value, key);
  return true;
});

describe("Delivery answers", () => {
  it("accepts only the matching acknowledgement", async () => {
    await contract.readDeliveryAcknowledgement(json(200, { accepted: true, eventId: EVENT, revision: 4, status: "received" }), EVENT);
    await rejectsWith(contract.readDeliveryAcknowledgement(json(200, { accepted: true, eventId: "other" }), EVENT), { code: "REMOTE_ACK_MISMATCH" });
  });

  it("keeps Deseret's exact error code on a rejection", async () => {
    await rejectsWith(contract.readDeliveryAcknowledgement(json(409, { code: "request_reused" }), EVENT), { code: "REMOTE_409", httpStatus: 409, remoteCode: "request_reused" });
    await rejectsWith(contract.readDeliveryAcknowledgement(json(409, { code: "publication_reused" }), EVENT), { code: "REMOTE_409", remoteCode: "publication_reused" });
  });

  it("does not invent a code from an unreadable or malformed rejection", async () => {
    await rejectsWith(contract.readDeliveryAcknowledgement(new Response("<html>conflict</html>", { status: 409 }), EVENT), { code: "REMOTE_409", remoteCode: undefined });
    await rejectsWith(contract.readDeliveryAcknowledgement(json(409, { code: "Request Reused!" }), EVENT), { code: "REMOTE_409", remoteCode: undefined });
    await rejectsWith(contract.readDeliveryAcknowledgement(json(409, { error: "request_reused" }), EVENT), { code: "REMOTE_409", remoteCode: undefined });
  });
});

describe("Receipt lookup", () => {
  const query = { eventId: EVENT, projectId: "db-project-1", bodySha256: createHash("sha256").update("legacy body").digest("hex") };

  it("is an authenticated POST to the receipt endpoint with the event id as request id", () => {
    const request = contract.receiptLookupRequest(config, query);
    assert.equal(request.url.href, "https://deseret.example.test/api/integrations/aigc/events/receipt");
    assert.equal(request.init.method, "POST");
    assert.equal(request.init.redirect, "error");
    assert.deepEqual(JSON.parse(request.init.body), query);
    const headers = request.init.headers;
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers["x-lw-request-id"], EVENT);
    assert.equal(contract.verifyIntegrationRequest({ headers, expectedSender: "aigc", keyId: config.outgoingKeyId, secret: config.outgoingSecret,
      method: "POST", pathAndQuery: "/api/integrations/aigc/events/receipt", body: request.init.body }), true);
  });

  it("rejects a malformed lookup before anything is sent", () => {
    assert.throws(() => contract.receiptLookupRequest(config, { ...query, bodySha256: "ABC" }));
    assert.throws(() => contract.receiptLookupRequest(config, { ...query, eventId: "../x" }));
    assert.throws(() => contract.receiptLookupRequest({ ...config, enabled: false }, query));
  });

  it("confirms only an exact matching receipt", async () => {
    assert.equal(await contract.readReceiptConfirmation(json(200, { accepted: true, eventId: EVENT, status: "received" }), EVENT), true);
    for (const body of [{ accepted: false, eventId: EVENT, status: "received" }, { accepted: true, eventId: "other", status: "received" }, { accepted: true, eventId: EVENT, status: "pending" }, {}])
      assert.equal(await contract.readReceiptConfirmation(json(200, body), EVENT), false, JSON.stringify(body));
    assert.equal(await contract.readReceiptConfirmation(json(404, { code: "not_found" }), EVENT), false);
  });

  it("reports other lookup failures as errors to retry, not as an answer", async () => {
    await rejectsWith(contract.readReceiptConfirmation(json(503, {}), EVENT), { code: "REMOTE_503" });
    await rejectsWith(contract.readReceiptConfirmation(json(401, {}), EVENT), { code: "REMOTE_401" });
  });
});
