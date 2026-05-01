/**
generate_llms_docs.js — Elavon Payment Gateway Documentation Generator
=======================================================================
Reads `complete-api-documentation.json` and produces:
  output/
  ├── llms.txt          # Structured index for LLM consumption
  └── apis/
      ├── <slug>.md     # One Markdown file per API / document entry
      └── ...

Usage:
    node generate_llms_docs.js

Requirements: Node.js 20+, no third-party dependencies.
*/

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const INPUT_FILE = "complete-api-documentation.json";
const OUTPUT_DIR = "output";
const APIS_DIR = path.join(OUTPUT_DIR, "apis");
const LLMS_FILE = path.join(OUTPUT_DIR, "llms.txt");
const PRODUCT_DISPLAY_NAME = "Elavon Payment Gateway";
// Maximum line count for a single markdown file before it is considered
// a raw dump / mega-file and gets filtered to a summary placeholder.
const MAX_CONTENT_LINES = 2000;
// Maximum character length for a description in llms.txt entries.
const DESC_MAX_LEN = 200;

const log = {
  info(fmt, ...args) {
    console.log(`INFO: ${util.format(fmt, ...args)}`);
  },
  warning(fmt, ...args) {
    console.warn(`WARNING: ${util.format(fmt, ...args)}`);
  },
  error(fmt, ...args) {
    console.error(`ERROR: ${util.format(fmt, ...args)}`);
  },
};

// ---------------------------------------------------------------------------
// Documentation topic groups - maps subPageId patterns to human-readable
// section names. Order here determines display order in llms.txt.
// ---------------------------------------------------------------------------

const DOC_TOPIC_ORDER = [
  ["Getting Started", "getting-started", [
    "overview",
    "create-account",
    "sending-api-requests",
    "api-reference",
  ]],
  ["Online Payments", "online-payments", [
    "sale_transaction",
    "void-transaction",
    "refund_transaction",
  ]],
  ["Digital Wallets", "digital-wallets", [
    "apple-pay",
    "google-pay",
    "wallet-management-overview",
    "wallets",
  ]],
  ["Hosted Payments", "hosted-payments", [
    "hosted-payments-overview",
    "redirect-sdk",
    "lightbox-sdk",
    "customize-payment-page",
    "collect-additional-info",
  ]],
  ["Lightbox JS Library", "lightbox-js-library", [
    "lightbox-js-library-overview",
    "elavonlightbox-constructor",
    "messagehandler-function-lightbox",
    "defaultaction-function",
    "onready-function-lightbox",
    "show-function-lightbox",
    "hide-function-lightbox",
  ]],
  ["Hosted Fields JS Library", "hosted-fields-js-library", [
    "fields-quickstart-sdk",
    "fields-js-library-overview",
    "elavonhostedfields-function",
    "messagehandler-function",
    "getstate-function",
    "onready-function-fields",
    "onTransactionSubmission-function",
    "addclass-function",
    "removeclass-function",
    "setattribute-function",
    "submit-function",
    "updatesession-function",
    "destroy-function",
    "show-function-fields",
    "onsurchargeacknowledgementrequired-function",
  ]],
  ["Subscriptions & Plans", "subscriptions-and-plans", [
    "scheduled-payments",
    "create-plans-and-subscriptions",
    "manage-plans-and-subscriptions",
    "choose-subscription-email-settings",
  ]],
  ["Advanced Features", "advanced-features", [
    "cof-transactions",
    "payment-links",
    "payment-method-capture",
    "hosted-cards",
    "stored-shoppers-and-cards",
    "3dsecure",
    "create-transaction-surcharge",
    "refund-transaction-with-surcharge",
    "dynamic-currency-conversion",
    "dynamic-currency-conversion-compliance",
    "webhook-notifications",
    "expand-query-parameter",
  ]],
  ["Reference", "reference", [
    "error-codes",
  ]],
];

// Docs that go in the ## Optional section (supplementary, not essential for integration)
const OPTIONAL_TOPIC_ORDER = [
  ["Supplementary", "supplementary", [
    "testing",
    "release-notes",
    "faqs",
  ]],
];

// CRUD-style ordering for API methods within a tag group.
// Lower number = listed first. POST (create) -> GET (list) -> GET (by id) -> POST (update) -> DELETE
const _METHOD_ORDER = { post: 0, get: 1, delete: 2 };
void _METHOD_ORDER;

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function asString(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function pythonString(value) {
  if (value === undefined) {
    return "";
  }
  if (value === null) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  return String(value);
}

function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function slugify(text) {
  // Convert arbitrary text into a deterministic, URL-safe filename slug.
  let slug = asString(text).toLowerCase().trim();
  slug = slug.replace(/[^a-z0-9]+/g, "-");
  slug = slug.replace(/^-+|-+$/g, "");
  return slug || "unnamed";
}

function normalizeText(text) {
  // Strip and collapse internal whitespace for display-quality text.
  return asString(text).split(/\s+/u).join(" ").trim();
}

function isGarbageLine(line) {
  // Return true for lines that are UI mockup artifacts, not documentation.
  const stripped = asString(line).trim();
  if (!stripped) {
    return true;
  }
  // Image references like "Sock Clothing [/images/socks.png]"
  if (/\[\/images\/[^\]]+\]/.test(stripped)) {
    return true;
  }
  // All-caps UI labels like "ORDER SUMMARY", "ORDER TOTAL: $17.50"
  if (
    stripped === stripped.toUpperCase()
    && stripped.length > 3
    && /^[A-Z][A-Z\s:$0-9.!,]+$/.test(stripped)
  ) {
    return true;
  }
  // Known UI button / placeholder text
  const lowered = stripped.toLowerCase();
  if (lowered === "buy now" || lowered === "continue shopping" || lowered === "keep shopping!") {
    return true;
  }
  // YAML metadata lines leaked from OpenAPI spec headers
  if (/^(title|version|openapi|info):\s/.test(stripped)) {
    return true;
  }
  return false;
}

function truncateAtWordBoundary(text, maxLen) {
  if (text.length <= maxLen) {
    return text;
  }
  const truncated = text.slice(0, maxLen - 3);
  const lastSpace = truncated.lastIndexOf(" ");
  const base = lastSpace === -1 ? truncated : truncated.slice(0, lastSpace);
  return `${base}...`;
}

function extractFirstSentence(text, maxLen = DESC_MAX_LEN) {
  // Extract the first meaningful sentence from a block of text.
  const paragraphs = [];
  let current = [];

  for (const line of asString(text).split("\n")) {
    const stripped = line.trim();
    const isBreak = !stripped
      || stripped.startsWith("#")
      || stripped.startsWith(":::")
      || stripped.startsWith("|")
      || isGarbageLine(stripped);

    if (isBreak) {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(stripped);
  }

  if (current.length > 0) {
    paragraphs.push(current.join(" "));
  }

  for (let para of paragraphs) {
    // Python re.sub(...) defaults to replacing all matches; JS needs /g explicitly.
    para = para.replace(/:magic-link\[([^\]]+)\]\{[^}]+\}/g, "$1");
    para = para.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    para = para.replace(/\*\*([^*]+)\*\*/g, "$1");
    para = para.replace(/\[\/images\/[^\]]+\]/g, "");
    const clean = normalizeText(para);

    if (clean.length < 10 || isGarbageLine(clean)) {
      continue;
    }

    const match = clean.match(/^(.+?[.!?])(?:\s|$)/);
    let sentence = match ? match[1] : clean;
    sentence = truncateAtWordBoundary(sentence, maxLen);
    return sentence;
  }

  return "";
}

function fileSha256(filePath) {
  // Return the SHA-256 hex digest of a file.
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function countChar(text, char) {
  let count = 0;
  for (const c of text) {
    if (c === char) {
      count += 1;
    }
  }
  return count;
}

function ensureTrailingNewline(text) {
  return `${asString(text).trimEnd()}\n`;
}

function compareTuple(a, b) {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] < b[i]) {
      return -1;
    }
    if (a[i] > b[i]) {
      return 1;
    }
  }
  return a.length - b.length;
}

function parseGenAiSpec(raw) {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return asObject(parsed);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function loadInput(filePath) {
  // Load and validate the input JSON, returning the list of product entries.
  log.info("Loading %s ...", filePath);
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const products = data?.products;

  if (!Array.isArray(products)) {
    log.error("Expected top-level 'products' array in %s", filePath);
    const error = new Error("Invalid input schema");
    error.alreadyLogged = true;
    throw error;
  }

  log.info("Loaded %d entries.", products.length);
  return products;
}

function classifyEntry(source) {
  // Return 'api' for YAML API endpoints with an HTTP method, else 'doc'.
  if (source?.isYaml && source?.yamlHttpReqMethod) {
    return "api";
  }
  if (source?.isYaml && !source?.yamlHttpReqMethod) {
    return "yaml-overview";
  }
  return "doc";
}

// ---------------------------------------------------------------------------
// Title disambiguation
// ---------------------------------------------------------------------------

// Maps ambiguous doc titles to their subPageId-based qualified names.
const DOC_TITLE_QUALIFIERS = {
  "fields-js-library-overview": "Hosted Fields JS Library Overview",
  "hosted-payments-overview": "Hosted Payments Overview",
  "wallet-management-overview": "Wallet Management Overview",
  "messagehandler-function-lightbox": "messageHandler Function (Lightbox)",
  "messagehandler-function": "messageHandler Function (Hosted Fields)",
  "onready-function-lightbox": "onReady Function (Lightbox)",
  "onready-function-fields": "onReady Function (Hosted Fields)",
  "show-function-lightbox": "show Function (Lightbox)",
  "show-function-fields": "show Function (Hosted Fields)",
  "hide-function-lightbox": "hide Function (Lightbox)",
  "dynamic-currency-conversion-compliance": "Dynamic Currency Conversion (Compliance)",
};

function disambiguatedDocTitle(source) {
  // Return a unique, human-readable title for a doc entry.
  const subPage = asString(source?.subPageId ?? "");
  if (Object.prototype.hasOwnProperty.call(DOC_TITLE_QUALIFIERS, subPage)) {
    return DOC_TITLE_QUALIFIERS[subPage];
  }
  return normalizeText(source?.title ?? "Untitled");
}

// ---------------------------------------------------------------------------
// Slug / filename generation
// ---------------------------------------------------------------------------

function makeApiSlug(source) {
  // Deterministic slug for an API endpoint entry.
  const method = asString(source?.yamlHttpReqMethod ?? "").toLowerCase();
  const endpointPath = asString(source?.yamlKey ?? "unknown");
  const pathPart = slugify(endpointPath);
  return method ? `${method}-${pathPart}` : pathPart;
}

function makeDocSlug(source) {
  // Deterministic slug for a documentation page entry.
  const subPage = asString(source?.subPageId ?? "");
  if (subPage) {
    return slugify(subPage);
  }
  return slugify(source?.title ?? "untitled");
}

function deduplicateSlugs(entries) {
  // Ensure every slug is unique by appending a numeric suffix on collision.
  const seen = new Map();
  const result = [];

  for (const [kind, originalSlug, source] of entries) {
    let slug = originalSlug;
    if (seen.has(slug)) {
      const next = seen.get(slug) + 1;
      seen.set(slug, next);
      slug = `${slug}-${next}`;
    } else {
      seen.set(slug, 0);
    }
    result.push([kind, slug, source]);
  }

  return result;
}

// ---------------------------------------------------------------------------
// CRUD-aware ordering for API endpoints within a tag group
// ---------------------------------------------------------------------------

function apiSortKey(_slug, source) {
  // Sort key that orders API endpoints by CRUD semantics.
  const method = asString(source?.yamlHttpReqMethod ?? "").toLowerCase();
  const endpointPath = asString(source?.yamlKey ?? "");
  const pathDepth = countChar(endpointPath, "/");
  const hasId = endpointPath.includes("{id}") || endpointPath.includes("{") ? 1 : 0;

  let methodRank;
  if (method === "post") {
    methodRank = hasId ? 3 : 0;
  } else if (method === "get") {
    methodRank = hasId ? 2 : 1;
  } else if (method === "delete") {
    methodRank = 4;
  } else {
    methodRank = 5;
  }

  return [methodRank, pathDepth, endpointPath];
}

// ---------------------------------------------------------------------------
// Markdown generation - API endpoints
// ---------------------------------------------------------------------------

function renderParametersTable(parameters) {
  // Render OpenAPI-style parameters as a Markdown table.
  if (!Array.isArray(parameters) || parameters.length === 0) {
    return "";
  }

  const lines = [
    "| Name | In | Description | Type | Required | Example |",
    "|------|----|-------------|------|----------|---------|",
  ];

  for (const rawParam of parameters) {
    const p = asObject(rawParam);
    const name = asString(p.name ?? "");
    const location = asString(p.in ?? "");
    const desc = asString(p.description ?? "").replace(/\n/g, " ").replace(/\|/g, "\\|");
    const schema = asObject(p.schema);
    const ptype = asString(schema.type ?? "");
    const required = p.required ? "Yes" : "No";
    const example = pythonString(schema.example ?? "").replace(/\|/g, "\\|");
    lines.push(`| ${name} | ${location} | ${desc} | ${ptype} | ${required} | ${example} |`);
  }

  return lines.join("\n");
}

function renderSchemaProperties(schema, indent = 0) {
  // Recursively render schema properties as a Markdown list.
  const schemaObj = asObject(schema);
  const props = asObject(schemaObj.properties);
  const requiredFields = new Set(asArray(schemaObj.required));
  const propEntries = Object.entries(props);

  if (propEntries.length === 0) {
    return "";
  }

  const lines = [];
  const prefix = "  ".repeat(indent);

  for (const [name, detailsRaw] of propEntries) {
    const details = asObject(detailsRaw);
    const ptype = asString(details.type ?? "object");
    const desc = asString(details.description ?? "").replace(/\n/g, " ");
    const reqMarker = requiredFields.has(name) ? " **(required)**" : "";
    const example = details.example ?? "";
    const exampleStr = example ? ` — Example: \`${pythonString(example)}\`` : "";
    const readOnly = details.readOnly ? " *(read-only)*" : "";
    lines.push(`${prefix}- **${name}** (\`${ptype}\`)${reqMarker}${readOnly}: ${desc}${exampleStr}`);

    if (details.properties) {
      lines.push(renderSchemaProperties(details, indent + 1));
    }

    const items = asObject(details.items);
    if (items.properties) {
      lines.push(renderSchemaProperties(items, indent + 1));
    }
  }

  return lines.join("\n");
}

function renderRequestBody(requestBody) {
  // Render the requestBody section.
  const requestBodyObj = asObject(requestBody);
  if (Object.keys(requestBodyObj).length === 0) {
    return "";
  }

  const lines = ["## Request Body", ""];
  const bodyDesc = asString(requestBodyObj.description ?? "");
  if (bodyDesc) {
    lines.push(bodyDesc);
    lines.push("");
  }

  const content = asObject(requestBodyObj.content);
  for (const [mediaType, mediaObjRaw] of Object.entries(content)) {
    const mediaObj = asObject(mediaObjRaw);
    lines.push(`**Content-Type:** \`${mediaType}\``);
    lines.push("");

    const schema = asObject(mediaObj.schema);
    const schemaDesc = asString(schema.description ?? "");
    if (schemaDesc) {
      lines.push(schemaDesc);
      lines.push("");
    }

    const propsMd = renderSchemaProperties(schema);
    if (propsMd) {
      lines.push("### Properties");
      lines.push("");
      lines.push(propsMd);
      lines.push("");
    }

    const examples = asObject(mediaObj.examples);
    if (Object.keys(examples).length > 0) {
      lines.push("### Request Examples");
      lines.push("");
      for (const [exampleName, exObjRaw] of Object.entries(examples)) {
        const exObj = asObject(exObjRaw);
        const summary = asString(exObj.summary ?? exampleName);
        lines.push(`**${summary}**`);
        lines.push("");
        lines.push("```json");
        lines.push(JSON.stringify(exObj.value ?? {}, null, 2));
        lines.push("```");
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

function renderResponses(responses) {
  // Render the responses section.
  const responsesObj = asObject(responses);
  if (Object.keys(responsesObj).length === 0) {
    return "";
  }

  const lines = ["## Responses", ""];
  const sortedResponseEntries = Object.entries(responsesObj).sort(([a], [b]) => a.localeCompare(b));

  for (const [statusCode, respObjRaw] of sortedResponseEntries) {
    const respObj = asObject(respObjRaw);
    const desc = asString(respObj.description ?? "");
    lines.push(`### ${statusCode} — ${desc}`);
    lines.push("");

    const headers = asObject(respObj.headers);
    if (Object.keys(headers).length > 0) {
      lines.push("**Headers:**");
      lines.push("");
      for (const [headerName, headerObjRaw] of Object.entries(headers)) {
        const headerObj = asObject(headerObjRaw);
        const headerDesc = asString(headerObj.description ?? "");
        lines.push(`- \`${headerName}\`: ${headerDesc}`);
      }
      lines.push("");
    }

    const content = asObject(respObj.content);
    for (const [_mediaType, mediaObjRaw] of Object.entries(content)) {
      const mediaObj = asObject(mediaObjRaw);
      const schema = asObject(mediaObj.schema);
      const schemaDesc = asString(schema.description ?? "");

      if (schemaDesc) {
        lines.push(schemaDesc);
        lines.push("");
      }

      const propsMd = renderSchemaProperties(schema);
      if (propsMd) {
        lines.push("**Properties:**");
        lines.push("");
        lines.push(propsMd);
        lines.push("");
      }

      const examples = asObject(mediaObj.examples);
      if (Object.keys(examples).length > 0) {
        for (const [exampleName, exObjRaw] of Object.entries(examples)) {
          const exObj = asObject(exObjRaw);
          const summary = asString(exObj.summary ?? exampleName);
          lines.push(`**Example — ${summary}:**`);
          lines.push("");
          const value = exObj.value ?? {};
          let valueStr = JSON.stringify(value, null, 2);
          if (valueStr.length > 5000) {
            valueStr = `${valueStr.slice(0, 5000)}\n  ... (truncated)`;
          }
          lines.push("```json");
          lines.push(valueStr);
          lines.push("```");
          lines.push("");
        }
      }
    }
  }

  return lines.join("\n");
}

function generateApiMarkdown(source) {
  // Generate full Markdown content for a YAML API endpoint entry.
  const method = normalizeText(source?.yamlHttpReqMethod ?? "").toUpperCase();
  const endpointPath = normalizeText(source?.yamlKey ?? "");
  const tag = normalizeText(source?.yamlTag ?? "");
  const summary = normalizeText(source?.yamlSummary ?? "");
  const description = normalizeText(source?.yamlDescription ?? "");

  const spec = parseGenAiSpec(asString(source?.genAiContent ?? ""));

  const specDesc = asString(spec.description ?? "");
  const displayDesc = specDesc.length > description.length ? specDesc : description;

  const sections = [];

  const title = summary || `${method} ${endpointPath}`;
  sections.push(`# ${title}`);
  sections.push("");

  const operationId = asString(spec.operationId ?? "N/A");
  sections.push(`- **Tag:** ${tag}`);
  sections.push(`- **Operation ID:** ${operationId}`);
  sections.push(`- **Method:** \`${method}\``);
  sections.push(`- **Path:** \`${endpointPath}\``);
  sections.push("");

  if (displayDesc) {
    sections.push("## Description");
    sections.push("");
    sections.push(displayDesc);
    sections.push("");
  }

  const servers = asArray(spec.servers);
  if (servers.length > 0) {
    sections.push("## Endpoints");
    sections.push("");
    for (const srvRaw of servers) {
      const srv = asObject(srvRaw);
      const srvDesc = asString(srv.description ?? "");
      const srvUrl = asString(srv.url ?? "");
      sections.push(`- **${srvDesc}:** \`${srvUrl}\``);
    }
    sections.push("");
  }

  sections.push("## Authentication");
  sections.push("");
  sections.push("HTTP BASIC authentication over TLS 1.2+. Use your API public and secret key pair.");
  sections.push("");

  const parameters = asArray(spec.parameters);
  if (parameters.length > 0) {
    sections.push("## Parameters");
    sections.push("");
    sections.push(renderParametersTable(parameters));
    sections.push("");
  }

  const requestBody = asObject(spec.requestBody);
  if (Object.keys(requestBody).length > 0) {
    sections.push(renderRequestBody(requestBody));
  }

  const responses = asObject(spec.responses);
  if (Object.keys(responses).length > 0) {
    sections.push(renderResponses(responses));
  }

  return ensureTrailingNewline(sections.join("\n"));
}

// ---------------------------------------------------------------------------
// Markdown generation - documentation pages
// ---------------------------------------------------------------------------

function generateDocMarkdown(source) {
  // Generate Markdown for a non-API documentation page.
  const title = disambiguatedDocTitle(source);
  const subPage = asString(source?.subPageId ?? "");
  let content = asString(source?.genAiContent ?? "").trim();

  const sections = [];
  sections.push(`# ${title}`);
  sections.push("");

  if (subPage) {
    sections.push(`*Page: ${subPage}*`);
    sections.push("");
  }

  if (content) {
    const lines = content.split("\n");
    while (lines.length > 0 && (lines[0].trim().startsWith("# ") || !lines[0].trim())) {
      lines.shift();
    }
    content = lines.join("\n").trim();

    if (countChar(content, "\n") > MAX_CONTENT_LINES) {
      sections.push("> **Note:** This page contains a large reference document.");
      sections.push(`> Content has been included in full (${countChar(content, "\n")} lines).`);
      sections.push("");
    }

    sections.push(content);
    sections.push("");
  }

  return ensureTrailingNewline(sections.join("\n"));
}

function generateYamlOverviewMarkdown(source) {
  // Generate a summary placeholder for YAML overview entries.
  const title = normalizeText(source?.title ?? "API Reference Overview");
  const content = asString(source?.genAiContent ?? "").trim();

  const sections = [];
  sections.push(`# ${title} (OpenAPI Specification)`);
  sections.push("");
  sections.push("*This entry contains the OpenAPI specification overview for the Elavon Payment Gateway API.*");
  sections.push("");
  sections.push("For detailed endpoint documentation, see the individual API endpoint files in this directory.");
  sections.push("");

  if (content) {
    const overviewLines = [];
    let inOverview = false;

    for (const line of content.split("\n").slice(0, 200)) {
      const stripped = line.trim();
      if (stripped.startsWith("# Overview") || stripped.startsWith("## Overview")) {
        inOverview = true;
        overviewLines.push(stripped);
        continue;
      }

      if (inOverview) {
        if (stripped.startsWith("# ") || stripped.startsWith("## ")) {
          break;
        }
        overviewLines.push(line);
      }
    }

    if (overviewLines.length > 0) {
      sections.push("## API Overview");
      sections.push("");
      sections.push(...overviewLines);
      sections.push("");
    }
  }

  return ensureTrailingNewline(sections.join("\n"));
}

// ---------------------------------------------------------------------------
// Description extraction for llms.txt entries
// ---------------------------------------------------------------------------

function getApiDescription(source) {
  // Extract a rich, actionable description for an API entry in llms.txt.
  const method = asString(source?.yamlHttpReqMethod ?? "").toUpperCase();
  const endpointPath = asString(source?.yamlKey ?? "");

  const spec = parseGenAiSpec(asString(source?.genAiContent ?? ""));

  const operationId = asString(spec.operationId ?? "");
  let desc = asString(spec.description ?? "").trim();

  if (!desc) {
    desc = normalizeText(source?.yamlDescription ?? "");
  }

  let sentence = "";
  if (operationId && Object.prototype.hasOwnProperty.call(API_DESCRIPTION_OVERRIDES, operationId)) {
    sentence = API_DESCRIPTION_OVERRIDES[operationId];
  } else if (desc) {
    sentence = extractFirstSentence(desc, 120);
  }

  if (!sentence) {
    const summary = normalizeText(source?.yamlSummary ?? "");
    if (summary) {
      sentence = summary;
    }
  }

  let brief = `${method} ${endpointPath}`;
  if (sentence) {
    brief += ` — ${sentence}`;
  }

  const responses = asObject(spec.responses);
  let successCode = null;
  for (const code of ["201", "200", "204"]) {
    if (Object.prototype.hasOwnProperty.call(responses, code)) {
      successCode = code;
      break;
    }
  }
  if (successCode) {
    brief += ` [${successCode}]`;
  }

  if (["POST", "PUT", "PATCH"].includes(method)) {
    const requestBody = asObject(spec.requestBody);
    const content = asObject(requestBody.content);

    for (const [_ct, mediaObjRaw] of Object.entries(content)) {
      const mediaObj = asObject(mediaObjRaw);
      const schema = asObject(mediaObj.schema);
      const required = asArray(schema.required);
      if (required.length > 0) {
        brief += ` Requires: ${required.slice(0, 5).join(", ")}.`;
        break;
      }

      const examples = asObject(mediaObj.examples);
      if (Object.keys(examples).length > 0) {
        const summaries = Object.entries(examples)
          .slice(0, 3)
          .map(([name, exRaw]) => {
            const ex = asObject(exRaw);
            return asString(ex.summary ?? name);
          });
        brief += ` Examples: ${summaries.join("; ")}.`;
        break;
      }
    }
  }

  if (method === "GET" && !endpointPath.includes("{id}") && !endpointPath.includes("{")) {
    const params = asArray(spec.parameters);
    const queryParams = params
      .map((p) => asObject(p))
      .filter((p) => asString(p.in ?? "") === "query")
      .map((p) => asString(p.name ?? ""))
      .filter(Boolean);

    if (queryParams.length > 0) {
      brief += ` Query params: ${queryParams.slice(0, 5).join(", ")}.`;
    }
  }

  if (operationId && Object.prototype.hasOwnProperty.call(API_RESPONSE_HINTS, operationId)) {
    brief += ` ${API_RESPONSE_HINTS[operationId]}`;
  }

  if (operationId) {
    brief += ` (${operationId})`;
  }

  return brief;
}

// Description overrides for API endpoints whose auto-generated descriptions
// are thin, tautological, or otherwise unhelpful.
const API_DESCRIPTION_OVERRIDES = {
  // operationId -> override description (replaces the auto-generated sentence)
  CreatePanTokens: "Tokenize one or more PANs (card numbers) for PCI-compliant storage; tokens are unique per merchant.",
  RetrievePlanList: "A read-only collection of Plans associated with an Account for subscription billing.",
  RetrievePlanLists: "Retrieve all read-only PlanList resources (one per Account) containing subscription Plans.",
  Account: "Retrieve a single Account. A merchant may have multiple accounts, each with its own processor configuration.",
  RetrieveMerchant: "Retrieve details of a Merchant including name, contact info, and linked accounts.",
  RetrieveBatch: "Retrieve a single settlement batch containing its associated transactions.",
  RetrieveManualBatch: "Retrieve a Manual Batch created for manual settlement of selected transactions.",
  RetrieveNotification: "Retrieve details of a webhook notification event, including delivery status and payload.",
  RetrieveHsmCard: "Retrieve an HSM (Hardware Security Module) encrypted card resource used for terminal-based transactions.",
  CreateHsmCard: "Create an HSM-encrypted card resource for terminal/card-present transactions. Requires terminal and account entry mode.",
  // Tautological or thin auto-generated descriptions
  CreateApplePayPayment: "Submit an Apple Pay token to create a payment.",
  CreateGooglePayPayment: "Submit a Google Pay token to create a payment.",
  CreatePazePayment: "Submit a Paze wallet token to create a payment.",
  CreatePaymentMethodSession: "Create a session to capture a shopper's payment method without charging.",
  UpdatePaymentMethodLink: "Overwrite an existing payment method link (e.g., update custom fields).",
  CreateCardVerification: "Verify a card (zero-amount auth) without creating a transaction.",
  CreateManualBatch: "Mark selected transactions for manual settlement outside the automatic batch cycle.",
  CreateEmailReceiptRequest: "Send an email receipt for a completed transaction to a specified email address.",
  CreateAppleTapToPayToken: "Generate an Apple Tap to Pay token for in-person contactless acceptance.",
};

// Response shape hints for key API endpoints - appended to the
// auto-generated description in llms.txt to help LLMs generate accurate code.
const API_RESPONSE_HINTS = {
  // operationId -> short response shape hint
  CreateTransaction: "Returns: `{ id, href, type, state, total, isAuthorized, authorizationCode, card, ... }`.",
  RetrieveTransaction: "Returns: `{ id, href, type, state, total, isAuthorized, authorizationCode, card, order, batch, ... }`.",
  CreatePaymentSession: "Returns: `{ id, href, paymentPageUrl, order, ... }`.",
  RetrievePaymentSession: "Returns: `{ id, href, paymentPageUrl, order, state, transaction, ... }`.",
  CreateShopper: "Returns: `{ id, href, fullName, emailAddress, ... }`.",
  CreateStoredCard: "Returns: `{ id, href, last4, expirationMonth, expirationYear, cardBrand, shopper, ... }`.",
  CreateOrder: "Returns: `{ id, href, total, customReference, ... }`.",
  CreateSubscription: "Returns: `{ id, href, plan, storedCard, state, firstBillAt, nextBillAt, ... }`.",
  CreatePlan: "Returns: `{ id, href, name, billingInterval, total, ... }`.",
  CreatePaymentLink: "Returns: `{ id, href, paymentPageUrl, expiresAt, total, state, ... }`.",
  CreateForexAdvice: "Returns: `{ id, href, foreignTotal, exchangeRate, marginPercentage, ... }`.",
  CreateSurchargeAdvice: "Returns: `{ id, href, surchargeAmount, totalWithSurcharge, ... }`.",
};

// Hardcoded description overrides for entries whose source content is
// UI mockup text, raw YAML, or otherwise not extractable.
const DOC_DESCRIPTION_OVERRIDES = {
  "redirect-sdk": "Quickstart guide for integrating Elavon's hosted payment page via redirect, with code samples and a demo checkout flow.",
  "lightbox-sdk": "Quickstart guide for integrating Elavon's hosted payment page via lightbox modal overlay.",
  "fields-quickstart-sdk": "Quickstart guide for integrating Elavon Hosted Fields for secure, PCI-compliant payment data entry.",
  "submit-function": "The submit() function submits the hosted fields payment form to process the transaction.",
  "api-reference": "REST API reference for the Elavon Payment Gateway, covering authentication, request/response formats, versioning, and conventions.",
  "release-notes": "Latest release notes and changelog for the Elavon Payment Gateway API.",
  faqs: "Frequently asked questions about the Elavon Payment Gateway, including setup, features, and troubleshooting.",
  "scheduled-payments": "Guide to creating and managing scheduled recurring payments using the Transactions and Subscriptions resources.",
  "manage-plans-and-subscriptions": "Manage existing plans and subscriptions — pause, resume, cancel, update amount, and change billing dates.",
  "cof-transactions": "Process card-on-file (COF) transactions using stored card tokens for returning customers — includes merchant-initiated and shopper-initiated flows.",
  "payment-method-capture": "Capture a shopper's payment method (card details) without processing a transaction, for later use in card-on-file or subscription flows.",
  "expand-query-parameter": "Use the expand query parameter to inline nested resource fields in API responses, reducing the need for follow-up requests.",
  "webhook-notifications": "Configure push notifications (webhooks) for transaction, payment session, and payment link events with automatic retry on failure.",
  "stored-shoppers-and-cards": "Save a customer (Shopper) and their card details (StoredCard) for repeat purchases, subscriptions, and card-on-file flows.",
  "hosted-cards": "A hosted card is a single-use, PCI-compliant card token returned by a successful checkout using a payment session.",
  "payment-links": "Generate shareable payment links with expiration dates that let customers pay online without a custom checkout page.",
  wallets: "Enable digital wallets (Apple Pay, Google Pay) on the hosted payment page via the Payments Settings page of the EPG merchant portal.",
  "3dsecure": "Secure direct API transactions with 3-D Secure authentication and Elavon's fraud services to reduce chargebacks.",
  // Tightened descriptions for entries that were verbose
  "apple-pay": "Integrate Apple Pay for web payments; HPP redirect requires no extra work, direct API requires Apple developer registration.",
  "google-pay": "Integrate Google Pay for web payments using the EPG direct API or hosted payment page.",
  overview: "Elavon Payment Gateway (EPG) overview — capabilities, integration methods, and supported payment types.",
  "create-account": "Create an Elavon developer account to get sandbox API credentials for testing.",
  "sending-api-requests": "Step-by-step guide to sending your first API request (create a shopper) and verifying it in the merchant portal.",
  "sale-transaction": "Process one-off payments without saving your customers' card details.",
  "void-transaction": "Cancel (void) an unsettled sale or refund transaction before batch settlement.",
  "refund-transaction": "Refunding a transaction returns the money to the customer.",
  "hosted-payments-overview": "Overview of hosted integration methods: redirect, lightbox modal, and hosted fields.",
  "customize-payment-page": "Customize the hosted payment page — logo, company name, colors, fonts, button text, and data fields.",
  "collect-additional-info": "Collect billing/shipping addresses and email on the hosted payment page alongside payment details.",
  "lightbox-js-library-overview": "Overview of the Elavon Lightbox JS library for embedding a secure payment modal in web applications.",
  "elavonlightbox-constructor": "Initialize a Lightbox payment modal — accepts paymentSession URL, callbacks, and display options.",
  "messagehandler-function-lightbox": "Handle transaction-result and error messages posted from the Lightbox iframe to the parent page.",
  "defaultaction-function": "Built-in handler that auto-closes the Lightbox and redirects the shopper on transaction completion.",
  "onready-function-lightbox": "Callback fired when the Lightbox iframe has loaded and is ready to display; use to enable your pay button.",
  "show-function-lightbox": "Programmatically open the Lightbox modal overlay to start the payment flow.",
  "hide-function-lightbox": "Programmatically close the Lightbox modal without completing a transaction.",
  "fields-js-library-overview": "Overview of the Elavon Hosted Fields JS library for embedding secure, PCI-compliant payment input fields.",
  "elavonhostedfields-function": "Initialize Hosted Fields — pass paymentSession URL, field selectors, styling config, and event callbacks.",
  "messagehandler-function": "Callback invoked on field state changes (focus, blur, validity) and transaction lifecycle events.",
  "getstate-function": "Returns current validation and readiness status of all hosted fields; use before calling submit().",
  "onready-function-fields": "Callback fired when hosted field iframes are loaded and ready to accept input.",
  "onTransactionSubmission-function": "Pre-submit hook that runs custom validation logic before the transaction is sent to the gateway.",
  "addclass-function": "Add a CSS class to a hosted field iframe for dynamic styling (e.g., error highlighting).",
  "removeclass-function": "Remove a CSS class from a hosted field iframe (e.g., clear error state after correction).",
  "setattribute-function": "Update an HTML attribute (e.g., placeholder, aria-label) on a hosted field iframe.",
  "updatesession-function": "Swap the active payment session without re-rendering hosted fields — useful for updating order totals.",
  "destroy-function": "Tear down Hosted Fields, remove iframes from the DOM, and release event listeners.",
  "show-function-fields": "Make previously hidden hosted fields and digital wallet buttons visible on the page.",
  "onsurchargeacknowledgementrequired-function": "Callback to prompt the shopper for surcharge consent before the transaction proceeds.",
  "wallet-management-overview": "Manage digital wallets through the Shoppers and Stored Cards API resources.",
  "create-plans-and-subscriptions": "Create billing plans and subscribe customers for automated recurring charges.",
  "choose-subscription-email-settings": "Configure whether subscription transaction receipts are emailed to the customer.",
  "create-transaction-surcharge": "Add a surcharge to customer transactions to cover card-provider processing fees.",
  "refund-transaction-with-surcharge": "Refund a surcharged transaction — returns both the base amount and the surcharge to the customer.",
  "dynamic-currency-conversion": "Use ForexAdvice resources to track exchange rates between the card currency and the merchant settlement currency.",
  "dynamic-currency-conversion-compliance": "DCC compliance — give international customers the choice to pay in their home currency (Mastercard, Visa, Discover).",
  "error-codes": "Error response format and full list of error codes returned by unsuccessful API calls.",
  testing: "Sandbox test card numbers, amounts, and scenarios for simulating approvals, declines, and errors.",
};

function getDocDescription(source) {
  // Extract a concise description for a doc entry in llms.txt.
  const subPage = asString(source?.subPageId ?? "");
  if (Object.prototype.hasOwnProperty.call(DOC_DESCRIPTION_OVERRIDES, subPage)) {
    return DOC_DESCRIPTION_OVERRIDES[subPage];
  }
  const content = asString(source?.genAiContent ?? "");
  const sentence = extractFirstSentence(content);
  if (sentence) {
    return sentence;
  }
  return normalizeText(source?.title ?? "");
}

// ---------------------------------------------------------------------------
// llms.txt generation
// ---------------------------------------------------------------------------

function generateLlmsTxt(entries, sourceHash, generationTs, { includeInlineExamples = false } = {}) {
  // Produce the llms.txt index referencing all generated Markdown files.
  const lines = [];

  lines.push(`# ${PRODUCT_DISPLAY_NAME}`);
  lines.push("");
  lines.push("> API documentation and integration guides for Elavon Payment Gateway (EPG),");
  lines.push("> a payment processing solution for eCommerce and card-not-present (CNP) payments.");
  lines.push("> EPG supports direct REST API integration, hosted payment pages (redirect, lightbox, and");
  lines.push("> hosted fields), digital wallets (Apple Pay, Google Pay, Paze), recurring billing via");
  lines.push("> subscriptions, card-on-file transactions, surcharging, and dynamic currency conversion.");
  lines.push("");

  const totalApi = entries.filter(([kind]) => kind === "api").length;
  const totalDoc = entries.filter(([kind]) => kind === "doc" || kind === "yaml-overview").length;
  lines.push("## Metadata");
  lines.push("");
  lines.push(`- **Generated:** ${generationTs}`);
  lines.push(`- **Source:** ${INPUT_FILE}`);
  lines.push(`- **Source SHA-256:** \`${sourceHash}\``);
  lines.push("- **Format version:** 2.0");
  lines.push(`- **Total entries:** ${entries.length} (${totalDoc} docs, ${totalApi} API endpoints)`);
  lines.push("");

  lines.push("## Quick Reference");
  lines.push("");
  lines.push("- **Sandbox Base URL:** `https://uat.api.converge.eu.elavonaws.com`");
  lines.push("- **Production Base URL:** `https://api.eu.convergepay.com`");
  lines.push("- **Authentication:** HTTP BASIC over TLS 1.2+ (public key as username, secret key as password)");
  lines.push("- **Content-Type:** `application/json;charset=UTF-8`");
  lines.push("- **API Versioning:** Via `Accept-Version` request header (current version: `1`)");
  lines.push("- **Pagination:** Cursor-based via `pageToken`/`nextPageToken` query params; default limit `10`, max `200`");
  lines.push("- **Error format:** `{ \"status\": <http_code>, \"failures\": [{ \"code\": \"...\", \"description\": \"...\", \"field\": \"...\" }] }` — see [Error Codes](apis/error-codes.md)");
  lines.push("- **Rate limiting:** Enforced per API key; exceeding limits returns `429 Too Many Requests`. Specific thresholds are not published — implement exponential backoff with jitter on 429 responses.");
  lines.push("- **Conflict / Idempotency:** Duplicate or in-flight requests return `409 Conflict`");
  lines.push("");
  lines.push("### HTTP Status Codes");
  lines.push("");
  lines.push("| Code | Meaning | Typical Operation |");
  lines.push("|------|---------|-------------------|");
  lines.push("| `200` | OK | GET, POST update |");
  lines.push("| `201` | Created | POST create |");
  lines.push("| `204` | No Content | DELETE |");
  lines.push("| `400` | Bad Request | Validation failure |");
  lines.push("| `401` | Unauthorized | Invalid API key |");
  lines.push("| `403` | Forbidden | Public key used for non-hosted-card operation |");
  lines.push("| `404` | Not Found | Resource does not exist |");
  lines.push("| `409` | Conflict | Duplicate / in-flight request |");
  lines.push("| `429` | Too Many Requests | Rate limit exceeded |");
  lines.push("");
  lines.push("### Authentication Example");
  lines.push("");
  lines.push("```bash");
  lines.push("curl -X GET https://uat.api.converge.eu.elavonaws.com/merchants \\");
  lines.push('  -u "<public_key>:<secret_key>" \\');
  lines.push('  -H "Accept: application/json" \\');
  lines.push('  -H "Accept-Version: 1"');
  lines.push("```");
  lines.push("");

  lines.push("### Data Model");
  lines.push("");
  lines.push("```");
  lines.push("Merchant ──┬── Account ──┬── ProcessorAccount");
  lines.push("           │             ├── PlanList ── Plan ── Subscription");
  lines.push("           │             └── Terminal");
  lines.push("           │");
  lines.push("           └── Shopper ──┬── StoredCard ── Subscription");
  lines.push("                         └── StoredAchPayment");
  lines.push("");
  lines.push("Order ── PaymentSession ── Transaction ── Batch");
  lines.push("                                       └── TotalAdjustment");
  lines.push("");
  lines.push("PaymentLink ── PaymentLinkEvent");
  lines.push("PaymentMethodLink ── PaymentMethodSession");
  lines.push("```");
  lines.push("");
  lines.push("Key relationships: A **Merchant** has one or more **Accounts**, each with **ProcessorAccount** configs. ");
  lines.push("A **Shopper** holds **StoredCards** used for **Subscriptions** (tied to **Plans**). ");
  lines.push("An **Order** feeds into a **PaymentSession** which produces a **Transaction** settled in a **Batch**.");
  lines.push("");

  lines.push("### Key Enum Values");
  lines.push("");
  lines.push("| Field | Values |");
  lines.push("|-------|--------|");
  lines.push("| Transaction `type` | `sale`, `refund`, `void` |");
  lines.push("| Transaction `state` | `authorized`, `captured`, `settled`, `voided`, `declined`, `expired`, `settlementDelayed`, `rejected`, `heldForReview`, `authorizationPending`, `unknown` |");
  lines.push("| `shopperInteraction` | `ecommerce`, `mailOrder`, `telephoneOrder`, `merchantInitiated`, `inPerson` |");
  lines.push("| Subscription `state` | `active`, `completed`, `cancelled`, `unpaid`, `pastDue`, `unknown` |");
  lines.push("| Billing interval `timeUnit` | `day`, `week`, `month`, `year` |");
  lines.push("| `credentialOnFileType` | `none`, `recurring`, `subscription`, `unscheduled` |");
  lines.push("| Batch `state` | `submitted`, `settled`, `rejected`, `failed`, `unknown` |");
  lines.push("| Card `fundingSource` | `charge`, `credit`, `debit`, `deferredDebit`, `prepaid`, `unknown` |");
  lines.push("");

  if (includeInlineExamples) {
    lines.push("### Request Body Examples");
    lines.push("");
    lines.push("**Sale transaction (direct API):**");
    lines.push("");
    lines.push("```json");
    lines.push("POST /transactions");
    lines.push("{");
    lines.push('  "total": { "amount": "45.23", "currencyCode": "EUR" },');
    lines.push('  "card": {');
    lines.push('    "holderName": "John Smith",');
    lines.push('    "number": "4111111111111111",');
    lines.push('    "expirationMonth": "12",');
    lines.push('    "expirationYear": "2027"');
    lines.push('  },');
    lines.push('  "shopperInteraction": "ecommerce"');
    lines.push("}");
    lines.push("```");
    lines.push("");
    lines.push("**Refund transaction:**");
    lines.push("");
    lines.push("```json");
    lines.push("POST /transactions");
    lines.push("{");
    lines.push('  "type": "refund",');
    lines.push('  "parentTransaction": "https://api.eu.convergepay.com/transactions/{id}"');
    lines.push("}");
    lines.push("```");
    lines.push("");
    lines.push("**Payment session (hosted redirect):**");
    lines.push("");
    lines.push("```json");
    lines.push("POST /payment-sessions");
    lines.push("{");
    lines.push('  "order": "{order_href}",');
    lines.push('  "returnUrl": "https://merchant.com/return",');
    lines.push('  "cancelUrl": "https://merchant.com/cancel",');
    lines.push('  "doCreateTransaction": "true"');
    lines.push("}");
    lines.push("```");
    lines.push("");
    lines.push("**Create a plan:**");
    lines.push("");
    lines.push("```json");
    lines.push("POST /plans");
    lines.push("{");
    lines.push('  "name": "Monthly Premium",');
    lines.push('  "billingInterval": { "timeUnit": "month", "count": 1 },');
    lines.push('  "total": { "amount": "29.99", "currencyCode": "USD" }');
    lines.push("}");
    lines.push("```");
    lines.push("");
  }

  lines.push("### Common Workflows");
  lines.push("");
  lines.push("1. **Simple sale:** `POST /payment-sessions` → redirect/lightbox/hosted fields → `GET /transactions/{id}`");
  lines.push("2. **Direct API sale:** `POST /transactions` with card or hostedCard token");
  lines.push("3. **Save card for later:** `POST /shoppers` → `POST /stored-cards` with shopper href");
  lines.push("4. **Recurring billing:** `POST /plans` → `POST /subscriptions` with storedCard");
  lines.push('5. **Refund:** `POST /transactions` with `type: "refund"` and original transaction href');
  lines.push("6. **Apple/Google Pay:** `POST /apple-pay-payments` or `POST /google-pay-payments`");
  lines.push("");

  lines.push("### Webhook Event Types");
  lines.push("");
  lines.push("| Resource | Events |");
  lines.push("|----------|--------|");
  lines.push("| Transaction | `saleAuthorized`, `saleDeclined`, `saleHeldForReview`, `saleCaptured`, `saleSettled`, `voidAuthorized`, `voidDeclined`, `refundAuthorized`, `refundDeclined`, `refundCaptured`, `refundSettled` |");
  lines.push("| Payment Session | `expired`, `reset`, `saleDeclined`, `saleAuthorized`, `saleAuthorizationPending` |");
  lines.push("| Payment Link | `expired`, `saleDeclined`, `saleAuthorized`, `saleAuthorizationPending` |");
  lines.push("");
  lines.push("Webhook retry schedule: 30 s → 5 min → 1 h → 24 h (4 attempts). See [Webhook Notifications](apis/webhook-notifications.md).");
  lines.push("");

  lines.push("### JS Library CDN URLs");
  lines.push("");
  lines.push("| Library | Sandbox | Production |");
  lines.push("|---------|---------|------------|");
  lines.push("| Lightbox | `https://uat.hpp.converge.eu.elavonaws.com/client/index.js` | `https://hpp.na.elavonpayments.com/client/index.js` |");
  lines.push("| Hosted Fields | `https://uat.hpp.converge.eu.elavonaws.com/hosted-fields-client/index.js` | `https://hpp.na.elavonpayments.com/hosted-fields-client/index.js` |");
  lines.push("");

  const apiEntries = [];
  const docEntries = [];
  const yamlOverviewEntries = [];

  for (const [kind, slug, source] of entries) {
    if (kind === "api") {
      apiEntries.push([kind, slug, source]);
    } else if (kind === "yaml-overview") {
      yamlOverviewEntries.push([kind, slug, source]);
    } else {
      docEntries.push([kind, slug, source]);
    }
  }

  const docLookup = new Map();
  const placedSubPages = new Set();

  if (docEntries.length > 0 || yamlOverviewEntries.length > 0) {
    lines.push("## Documentation");
    lines.push("");

    for (const [_kind, slug, source] of docEntries) {
      const subPage = asString(source?.subPageId ?? slug);
      docLookup.set(subPage, [slug, source]);
    }

    for (const [groupName, _groupSlug, subPageIds] of DOC_TOPIC_ORDER) {
      const groupItems = [];
      for (const subPageId of subPageIds) {
        if (docLookup.has(subPageId)) {
          groupItems.push([subPageId, docLookup.get(subPageId)]);
          placedSubPages.add(subPageId);
        }
      }

      if (groupItems.length > 0) {
        lines.push(`### ${groupName}`);
        lines.push("");
        for (const [_subPageId, [slug, source]] of groupItems) {
          const title = disambiguatedDocTitle(source);
          const desc = getDocDescription(source);
          const relPath = `apis/${slug}.md`;
          lines.push(`- [${title}](${relPath}): ${desc}`);
        }
        lines.push("");
      }
    }

    const optionalSubPages = new Set();
    for (const [_groupName, _groupSlug, subPageIds] of OPTIONAL_TOPIC_ORDER) {
      for (const subPageId of subPageIds) {
        optionalSubPages.add(subPageId);
      }
    }

    const ungrouped = docEntries
      .map(([_kind, slug, source]) => [slug, source])
      .filter(([slug, source]) => {
        const subPage = asString(source?.subPageId ?? slug);
        return !placedSubPages.has(subPage) && !optionalSubPages.has(subPage);
      });

    if (ungrouped.length > 0) {
      lines.push("### Other Documentation");
      lines.push("");
      for (const [slug, source] of ungrouped) {
        const title = disambiguatedDocTitle(source);
        const desc = getDocDescription(source);
        const relPath = `apis/${slug}.md`;
        lines.push(`- [${title}](${relPath}): ${desc}`);
      }
      lines.push("");
    }

    if (yamlOverviewEntries.length > 0) {
      lines.push("### OpenAPI Specification");
      lines.push("");
      for (const [_kind, slug, source] of yamlOverviewEntries) {
        const title = normalizeText(source?.title ?? "API Reference");
        const relPath = `apis/${slug}.md`;
        lines.push(`- [${title} (OpenAPI Specification)](${relPath}): Full OpenAPI specification overview`);
      }
      lines.push("");
    }
  }

  if (apiEntries.length > 0) {
    lines.push("## API Reference");
    lines.push("");

    const tagGroups = new Map();
    for (const [_kind, slug, source] of apiEntries) {
      const tag = normalizeText(source?.yamlTag ?? "Other");
      if (!tagGroups.has(tag)) {
        tagGroups.set(tag, []);
      }
      tagGroups.get(tag).push([slug, source]);
    }

    for (const tag of [...tagGroups.keys()].sort((a, b) => a.localeCompare(b))) {
      lines.push(`### ${tag}`);
      lines.push("");

      // Python sorts by tuple key; this comparator preserves lexicographic tuple ordering.
      const sortedItems = [...tagGroups.get(tag)].sort((a, b) => compareTuple(apiSortKey(a[0], a[1]), apiSortKey(b[0], b[1])));

      for (const [slug, source] of sortedItems) {
        const summary = normalizeText(source?.yamlSummary ?? "");
        const display = summary || `${asString(source?.yamlHttpReqMethod ?? "").toUpperCase()} ${asString(source?.yamlKey ?? "")}`;
        const desc = getApiDescription(source);
        const relPath = `apis/${slug}.md`;
        lines.push(`- [${display}](${relPath}): ${desc}`);
      }
      lines.push("");
    }
  }

  let optionalItemsExist = false;
  for (const [_groupName, _groupSlug, subPageIds] of OPTIONAL_TOPIC_ORDER) {
    const groupItems = [];
    for (const subPageId of subPageIds) {
      if (docLookup.has(subPageId)) {
        groupItems.push([subPageId, docLookup.get(subPageId)]);
        placedSubPages.add(subPageId);
      }
    }

    if (groupItems.length > 0) {
      if (!optionalItemsExist) {
        lines.push("## Optional");
        lines.push("");
        optionalItemsExist = true;
      }

      for (const [_subPageId, [slug, source]] of groupItems) {
        const title = disambiguatedDocTitle(source);
        const desc = getDocDescription(source);
        const relPath = `apis/${slug}.md`;
        lines.push(`- [${title}](${relPath}): ${desc}`);
      }
    }
  }

  if (optionalItemsExist) {
    lines.push("");
  }

  return ensureTrailingNewline(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function run() {
  // Main entry point - parse, generate, write.
  const products = loadInput(INPUT_FILE);
  const sourceHash = fileSha256(INPUT_FILE);
  const generationTs = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const rawEntries = [];
  for (const productRaw of products) {
    const product = asObject(productRaw);
    const source = asObject(product._source);

    if (Object.keys(source).length === 0) {
      log.warning("Skipping entry with empty _source: %s", asString(product._id ?? ""));
      continue;
    }

    const kind = classifyEntry(source);
    const slug = kind === "api" ? makeApiSlug(source) : makeDocSlug(source);
    rawEntries.push([kind, slug, source]);
  }

  const kindOrder = { doc: 0, "yaml-overview": 1, api: 2 };
  rawEntries.sort((a, b) => compareTuple([kindOrder[a[0]] ?? 9, a[1]], [kindOrder[b[0]] ?? 9, b[1]]));

  const entries = deduplicateSlugs(rawEntries);

  fs.mkdirSync(APIS_DIR, { recursive: true });

  log.info("Generating %d Markdown files ...", entries.length);
  for (const [kind, slug, source] of entries) {
    let mdContent;
    if (kind === "api") {
      mdContent = generateApiMarkdown(source);
    } else if (kind === "yaml-overview") {
      mdContent = generateYamlOverviewMarkdown(source);
    } else {
      mdContent = generateDocMarkdown(source);
    }

    const mdPath = path.join(APIS_DIR, `${slug}.md`);
    fs.writeFileSync(mdPath, mdContent, "utf-8");
  }

  log.info("Generating llms.txt ...");
  const llmsContent = generateLlmsTxt(entries, sourceHash, generationTs);
  fs.writeFileSync(LLMS_FILE, llmsContent, "utf-8");

  log.info("Done. Output written to %s/", OUTPUT_DIR);
  log.info("  llms.txt:      %d entries indexed", entries.length);
  log.info("  apis/:         %d Markdown files", entries.length);
}

function main() {
  try {
    run();
  } catch (error) {
    if (!error?.alreadyLogged) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("%s", msg);
    }
    process.exit(1);
  }
}

main();

export { run };