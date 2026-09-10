import postgres from "postgres";

const globalForSql = globalThis as unknown as {
  metricsSql?: ReturnType<typeof postgres>;
};

function databaseUrl(): string {
  const url =
    process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL;
  if (!url) {
    throw new Error("missing env SUPABASE_DB_URL");
  }
  return url;
}

export function sql() {
  if (!globalForSql.metricsSql) {
    globalForSql.metricsSql = postgres(databaseUrl(), {
      ssl: "require",
      max: 1,
      idle_timeout: 20,
      connect_timeout: 15,
      prepare: false,
    });
  }
  return globalForSql.metricsSql;
}
