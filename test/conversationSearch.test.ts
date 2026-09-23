import assert from "node:assert/strict";
import test from "node:test";
import { searchConversations } from "../src/lib/conversationSearch.ts";

const sessions = [
  { session_id: "one", title: "Landing page", workspace: "C:/work/web" },
  { session_id: "two", title: "API review", workspace: "C:/work/api" },
];

test("searchConversations matches metadata and message content", () => {
  const hits = searchConversations(sessions, {
    one: [{ text: "Implement the responsive hero" }],
    two: [{ text: "Check the auth middleware" }],
  }, "middleware");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].session.session_id, "two");
  assert.match(hits[0].excerpt ?? "", /auth middleware/);
});

test("searchConversations returns all sessions for an empty query", () => {
  assert.deepEqual(
    searchConversations(sessions, {}, "").map((hit) => hit.session.session_id),
    ["one", "two"],
  );
});

test("searchConversations lists the most recently active conversation first", () => {
  const dated = [
    { session_id: "old", title: "Old", workspace: "C:/w", createdAt: 1 },
    { session_id: "fresh", title: "Fresh", workspace: "C:/w", createdAt: 2 },
    { session_id: "busy", title: "Busy", workspace: "C:/w", createdAt: 0 },
  ];
  const logs = { busy: [{ text: "latest message", ts: 9 }] };
  assert.deepEqual(
    searchConversations(dated, logs, "").map((hit) => hit.session.session_id),
    ["busy", "fresh", "old"],
  );
});
