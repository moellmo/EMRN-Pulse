import Typesense from "typesense";

function typesenseNode() {
  const host = process.env.TYPESENSE_HOST;
  if (!host) throw new Error("TYPESENSE_HOST is required.");

  return {
    host,
    port: Number(process.env.TYPESENSE_PORT || 443),
    protocol: process.env.TYPESENSE_PROTOCOL || "https",
  };
}

export function getTypesenseAdmin() {
  const apiKey = process.env.TYPESENSE_ADMIN_API_KEY;
  if (!apiKey) throw new Error("TYPESENSE_ADMIN_API_KEY is required.");

  return new Typesense.Client({
    nodes: [typesenseNode()],
    apiKey,
    connectionTimeoutSeconds: 10,
  });
}

export function getTypesenseSearch() {
  const apiKey = process.env.TYPESENSE_SEARCH_API_KEY;
  if (!apiKey) throw new Error("TYPESENSE_SEARCH_API_KEY is required.");

  return new Typesense.Client({
    nodes: [typesenseNode()],
    apiKey,
    connectionTimeoutSeconds: 5,
  });
}
