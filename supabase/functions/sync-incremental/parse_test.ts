import { parseJsonl, parseJsonlLine } from "./parse.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

function assertDeepEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  const stableJson = (value: unknown): string => {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableJson(item)).join(",")}]`;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return `{${
        Object.keys(record).sort().map((key) =>
          `${JSON.stringify(key)}:${stableJson(record[key])}`
        ).join(",")
      }}`;
    }
    return JSON.stringify(value);
  };

  const actualJson = stableJson(actual);
  const expectedJson = stableJson(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

Deno.test("parse matches the three-line Mixpanel fixture", async () => {
  const fixture = await Deno.readTextFile(
    new URL("../../../tests/fixtures/sample_day.jsonl", import.meta.url),
  );
  const result = await parseJsonl(`${fixture}\n\n`);

  assertEquals(result.nonEmptyLines, 3, "non-empty line count");
  assertEquals(result.rows.length, 3, "row count");
  assertEquals(result.synthesized, 1, "synthesized count");
  assertEquals(result.rows[0].insert_id, "ins_signup_1", "real insert id");
  assertEquals(result.rows[0].user_id, "user-1", "dollar user id");
  assertEquals(result.rows[1].company_id, "99", "numeric company id");
  assert(result.rows[2].insert_id.startsWith("syn_"), "synthesized prefix");

  const repeated = await parseJsonl(fixture);
  assertEquals(
    result.rows[2].insert_id,
    repeated.rows[2].insert_id,
    "synthesized id is stable",
  );
});

Deno.test("parse applies event_properties.v1 normalization and allowlist", async () => {
  const row = await parseJsonlLine(JSON.stringify({
    event: "Upload",
    properties: {
      time: 1756944000,
      $insert_id: "ins_properties_1",
      distinct_id: "user-1",
      $user_id: "user-1",
      ucUuid: "uc-1",
      email: "user@example.com",
      companyId: "company-1",
      company: "company-1",
      companyName: "  Acme  ",
      type: " GST2B ",
      subType: " legacy ",
      status: "success",
      fileType: " application/pdf ",
      source: " Header ",
      entityType: " bill ",
      transactionType: " Payment ",
      action: " Save & Mark as Accounting Ready ",
      productCode: " gstr ",
      widgetName: " Upload Widget ",
      flow: " Sign Up ",
      method: " GOOGLE ",
      viewSource: " Dashboard ",
      isReactivation: true,
      items_count: 3,
      fileName: "invoice.pdf",
      gstin: "29ABCDE1234F1Z5",
      sync_items: { count: 3 },
      from: "ignored",
      to: "ignored",
      bankLineUuid: "ignored",
      periodFrom: "ignored",
      periodTo: "ignored",
      outcome: "ignored",
      stage: "ignored",
      reason: "ignored",
      attemptsRemaining: 1,
      productUuid: "ignored",
      userUuid: "ignored",
      createdBy: "ignored",
      fromCompanyId: "ignored",
      fromCompanyName: "ignored",
      toCompanyId: "ignored",
      toCompanyName: "ignored",
      organisationId: "ignored",
      toolConnected: true,
      configField: "ignored",
      newState: "ignored",
      previousState: "ignored",
      pageName: "ignored",
      templateType: "ignored",
      tool: "ignored",
      transactionCount: 1,
      itemsCount: 1,
      signUpDate: "ignored",
      signUpMethod: "ignored",
      billingExpected: true,
      timestamp: "ignored",
      $reserved: "ignored",
      mp_reserved: "ignored",
      unlisted: "ignored",
    },
  }));

  assertDeepEquals(row.properties, {
    companyName: "Acme",
    type: "gstr2b",
    subType: "bank",
    status: "Success",
    fileType: "application/pdf",
    source: "Header",
    entityType: "bill",
    action: "Save & Mark as Accounting Ready",
    productCode: "gstr",
    widgetName: "Upload Widget",
    flow: "Sign Up",
    method: "GOOGLE",
    viewSource: "Dashboard",
    transactionType: "payment",
    isReactivation: true,
    items_count: 3,
  }, "allowlisted properties");
  assertEquals(row.distinct_id, "user-1", "distinct_id remains a column");
  assertEquals(row.company_id, "company-1", "company_id remains a column");
  assert(!("fileName" in row.properties), "fileName is dropped");
  assert(!("gstin" in row.properties), "gstin is dropped");
  assert(!("sync_items" in row.properties), "sync_items is dropped");
  assert(!("company" in row.properties), "company identity is not copied");
});

Deno.test("parse preserves UUID transaction types and drops invalid scalar values", async () => {
  const row = await parseJsonlLine(JSON.stringify({
    event: "Transaction Status",
    properties: {
      time: 1756944000,
      $insert_id: "ins_properties_2",
      distinct_id: "user-2",
      transactionType: " ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF ",
      status: "Accounting Ready",
      isReactivation: "true",
      items_count: "not-a-number",
    },
  }));

  assertDeepEquals(row.properties, {
    transactionType: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
    status: "Accounting Ready",
  }, "UUID and scalar normalization");
});

Deno.test("parse omits a missing Upload subtype", async () => {
  const row = await parseJsonlLine(JSON.stringify({
    event: "Upload",
    properties: {
      time: 1756944000,
      $insert_id: "ins_properties_3",
      distinct_id: "user-3",
    },
  }));

  assertDeepEquals(
    row.properties,
    {},
    "missing Upload subtype",
  );
});
