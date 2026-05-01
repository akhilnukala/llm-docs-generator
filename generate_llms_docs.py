#!/usr/bin/env python3
"""
generate_llms_docs.py — Elavon Payment Gateway Documentation Generator
=======================================================================
Reads `complete-api-documentation.json` and produces:
  output/
  ├── llms.txt          # Structured index for LLM consumption
  └── apis/
      ├── <slug>.md     # One Markdown file per API / document entry
      └── ...

Usage:
    python3 generate_llms_docs.py

Requirements: Python 3.9+, no third-party dependencies.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

INPUT_FILE = "complete-api-documentation.json"
OUTPUT_DIR = Path("output")
APIS_DIR = OUTPUT_DIR / "apis"
LLMS_FILE = OUTPUT_DIR / "llms.txt"
PRODUCT_DISPLAY_NAME = "Elavon Payment Gateway"
# Maximum line count for a single markdown file before it is considered
# a raw dump / mega-file and gets filtered to a summary placeholder.
MAX_CONTENT_LINES = 2000
# Maximum character length for a description in llms.txt entries.
DESC_MAX_LEN = 200

logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s: %(message)s",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Documentation topic groups — maps subPageId patterns to human-readable
# section names. Order here determines display order in llms.txt.
# ---------------------------------------------------------------------------

DOC_TOPIC_ORDER: list[tuple[str, str, list[str]]] = [
    ("Getting Started", "getting-started", [
        "overview",
        "create-account",
        "sending-api-requests",
        "api-reference",
    ]),
    ("Online Payments", "online-payments", [
        "sale_transaction",
        "void-transaction",
        "refund_transaction",
    ]),
    ("Digital Wallets", "digital-wallets", [
        "apple-pay",
        "google-pay",
        "wallet-management-overview",
        "wallets",
    ]),
    ("Hosted Payments", "hosted-payments", [
        "hosted-payments-overview",
        "redirect-sdk",
        "lightbox-sdk",
        "customize-payment-page",
        "collect-additional-info",
    ]),
    ("Lightbox JS Library", "lightbox-js-library", [
        "lightbox-js-library-overview",
        "elavonlightbox-constructor",
        "messagehandler-function-lightbox",
        "defaultaction-function",
        "onready-function-lightbox",
        "show-function-lightbox",
        "hide-function-lightbox",
    ]),
    ("Hosted Fields JS Library", "hosted-fields-js-library", [
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
    ]),
    ("Subscriptions & Plans", "subscriptions-and-plans", [
        "scheduled-payments",
        "create-plans-and-subscriptions",
        "manage-plans-and-subscriptions",
        "choose-subscription-email-settings",
    ]),
    ("Advanced Features", "advanced-features", [
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
    ]),
    ("Reference", "reference", [
        "error-codes",
    ]),
]

# Docs that go in the ## Optional section (supplementary, not essential for integration)
OPTIONAL_TOPIC_ORDER: list[tuple[str, str, list[str]]] = [
    ("Supplementary", "supplementary", [
        "testing",
        "release-notes",
        "faqs",
    ]),
]

# CRUD-style ordering for API methods within a tag group.
# Lower number = listed first.  POST (create) → GET (list) → GET (by id) → POST (update) → DELETE
_METHOD_ORDER = {"post": 0, "get": 1, "delete": 2}


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------


def slugify(text: str) -> str:
    """Convert arbitrary text into a deterministic, URL-safe filename slug."""
    slug = text.lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = slug.strip("-")
    return slug or "unnamed"


def normalize_text(text: str) -> str:
    """Strip and collapse internal whitespace for display-quality text."""
    return " ".join(text.split()).strip()


def _is_garbage_line(line: str) -> bool:
    """Return True for lines that are UI mockup artifacts, not documentation."""
    stripped = line.strip()
    if not stripped:
        return True
    # Image references like "Sock Clothing [/images/socks.png]"
    if re.search(r'\[/images/[^\]]+\]', stripped):
        return True
    # All-caps UI labels like "ORDER SUMMARY", "ORDER TOTAL: $17.50"
    if stripped == stripped.upper() and len(stripped) > 3 and re.match(r'^[A-Z][A-Z\s:$0-9.!,]+$', stripped):
        return True
    # Known UI button / placeholder text
    if stripped.lower() in ('buy now', 'continue shopping', 'keep shopping!'):
        return True
    # YAML metadata lines leaked from OpenAPI spec headers
    if re.match(r'^(title|version|openapi|info):\s', stripped):
        return True
    return False


def extract_first_sentence(text: str, max_len: int = DESC_MAX_LEN) -> str:
    """Extract the first meaningful sentence from a block of text.

    Joins consecutive non-heading lines into paragraphs before extracting,
    so multi-line sentences aren't broken.  Skips headings, image directives,
    UI mockup artifacts, and blank lines.
    """
    # Join consecutive content lines into paragraphs
    paragraphs: list[str] = []
    current: list[str] = []
    for line in text.split("\n"):
        stripped = line.strip()
        # Paragraph break on empty line, heading, directive, table, etc.
        if (not stripped
                or stripped.startswith("#")
                or stripped.startswith(":::")
                or stripped.startswith("|")
                or _is_garbage_line(stripped)):
            if current:
                paragraphs.append(" ".join(current))
                current = []
            continue
        current.append(stripped)
    if current:
        paragraphs.append(" ".join(current))

    for para in paragraphs:
        # Clean up markdown artifacts
        clean = re.sub(r":magic-link\[([^\]]+)\]\{[^}]+\}", r"\1", para)
        clean = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", clean)  # inline links
        clean = re.sub(r"\*\*([^*]+)\*\*", r"\1", clean)  # bold markers
        clean = re.sub(r"\[/images/[^\]]+\]", "", clean)  # stray image refs
        clean = normalize_text(clean)

        if len(clean) < 10 or _is_garbage_line(clean):
            continue

        # Take first sentence (period/!/? followed by space or end-of-string)
        match = re.match(r"^(.+?[.!?])(?:\s|$)", clean)
        sentence = match.group(1) if match else clean
        if len(sentence) > max_len:
            sentence = sentence[: max_len - 3].rsplit(" ", 1)[0] + "..."
        return sentence
    return ""


def file_sha256(path: str) -> str:
    """Return the SHA-256 hex digest of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def load_input(path: str) -> list[dict]:
    """Load and validate the input JSON, returning the list of product entries."""
    log.info("Loading %s ...", path)
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)

    products = data.get("products")
    if not isinstance(products, list):
        log.error("Expected top-level 'products' array in %s", path)
        sys.exit(1)

    log.info("Loaded %d entries.", len(products))
    return products


def classify_entry(source: dict) -> str:
    """Return 'api' for YAML API endpoints with an HTTP method, else 'doc'.

    YAML overview entries (isYaml=True but no HTTP method) that contain raw
    OpenAPI spec dumps are classified as 'yaml-overview' so they can be
    handled separately and not pollute the documentation index.
    """
    if source.get("isYaml") and source.get("yamlHttpReqMethod"):
        return "api"
    if source.get("isYaml") and not source.get("yamlHttpReqMethod"):
        return "yaml-overview"
    return "doc"


# ---------------------------------------------------------------------------
# Title disambiguation
# ---------------------------------------------------------------------------

# Maps ambiguous doc titles to their subPageId-based qualified names.
_DOC_TITLE_QUALIFIERS: dict[str, str] = {
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
}


def disambiguated_doc_title(source: dict) -> str:
    """Return a unique, human-readable title for a doc entry.

    Uses _DOC_TITLE_QUALIFIERS for known ambiguous titles, otherwise
    returns the normalized source title.
    """
    sub_page = source.get("subPageId", "")
    if sub_page in _DOC_TITLE_QUALIFIERS:
        return _DOC_TITLE_QUALIFIERS[sub_page]
    return normalize_text(source.get("title", "Untitled"))


# ---------------------------------------------------------------------------
# Slug / filename generation
# ---------------------------------------------------------------------------


def make_api_slug(source: dict) -> str:
    """Deterministic slug for an API endpoint entry.

    Combines the HTTP method and path to guarantee uniqueness even when
    multiple methods exist for the same path (e.g. GET /orders vs POST /orders).
    """
    method = source.get("yamlHttpReqMethod", "").lower()
    path = source.get("yamlKey", "unknown")
    path_part = slugify(path)
    return f"{method}-{path_part}" if method else path_part


def make_doc_slug(source: dict) -> str:
    """Deterministic slug for a documentation page entry."""
    sub_page = source.get("subPageId", "")
    if sub_page:
        return slugify(sub_page)
    return slugify(source.get("title", "untitled"))


def deduplicate_slugs(entries: list[tuple[str, str, dict]]) -> list[tuple[str, str, dict]]:
    """Ensure every slug is unique by appending a numeric suffix on collision."""
    seen: dict[str, int] = {}
    result = []
    for kind, slug, source in entries:
        if slug in seen:
            seen[slug] += 1
            slug = f"{slug}-{seen[slug]}"
        else:
            seen[slug] = 0
        result.append((kind, slug, source))
    return result


# ---------------------------------------------------------------------------
# CRUD-aware ordering for API endpoints within a tag group
# ---------------------------------------------------------------------------


def _api_sort_key(slug: str, source: dict) -> tuple:
    """Sort key that orders API endpoints by CRUD semantics.

    Order: POST (create) → GET collection → GET by ID → POST update → DELETE.
    Within the same method, shorter paths (collections) sort before longer
    paths (resource-by-id), giving a natural REST ordering.
    """
    method = source.get("yamlHttpReqMethod", "").lower()
    path = source.get("yamlKey", "")
    path_depth = path.count("/")
    has_id = 1 if "{id}" in path or "{" in path else 0

    # POST without {id} = create; POST with {id} = update
    if method == "post":
        method_rank = 0 if not has_id else 3
    elif method == "get":
        method_rank = 1 if not has_id else 2
    elif method == "delete":
        method_rank = 4
    else:
        method_rank = 5

    return (method_rank, path_depth, path)


# ---------------------------------------------------------------------------
# Markdown generation — API endpoints
# ---------------------------------------------------------------------------


def _render_parameters_table(parameters: list[dict]) -> str:
    """Render OpenAPI-style parameters as a Markdown table."""
    if not parameters:
        return ""
    lines = [
        "| Name | In | Description | Type | Required | Example |",
        "|------|----|-------------|------|----------|---------|",
    ]
    for p in parameters:
        name = p.get("name", "")
        location = p.get("in", "")
        desc = p.get("description", "").replace("\n", " ").replace("|", "\\|")
        schema = p.get("schema", {})
        ptype = schema.get("type", "")
        required = "Yes" if p.get("required") else "No"
        example = str(schema.get("example", "")).replace("|", "\\|")
        lines.append(f"| {name} | {location} | {desc} | {ptype} | {required} | {example} |")
    return "\n".join(lines)


def _render_schema_properties(schema: dict, indent: int = 0) -> str:
    """Recursively render schema properties as a Markdown list."""
    props = schema.get("properties", {})
    required_fields = set(schema.get("required", []))
    if not props:
        return ""
    lines = []
    prefix = "  " * indent
    for name, details in props.items():
        ptype = details.get("type", "object")
        desc = details.get("description", "").replace("\n", " ")
        req_marker = " **(required)**" if name in required_fields else ""
        example = details.get("example", "")
        example_str = f" — Example: `{example}`" if example else ""
        read_only = " *(read-only)*" if details.get("readOnly") else ""
        lines.append(f"{prefix}- **{name}** (`{ptype}`){req_marker}{read_only}: {desc}{example_str}")

        # Recurse into nested objects
        if details.get("properties"):
            lines.append(_render_schema_properties(details, indent + 1))
        # Handle array items
        items = details.get("items", {})
        if items.get("properties"):
            lines.append(_render_schema_properties(items, indent + 1))
    return "\n".join(lines)


def _render_request_body(request_body: dict) -> str:
    """Render the requestBody section."""
    if not request_body:
        return ""
    lines = ["## Request Body", ""]
    body_desc = request_body.get("description", "")
    if body_desc:
        lines.append(body_desc)
        lines.append("")

    content = request_body.get("content", {})
    for media_type, media_obj in content.items():
        lines.append(f"**Content-Type:** `{media_type}`")
        lines.append("")
        schema = media_obj.get("schema", {})
        schema_desc = schema.get("description", "")
        if schema_desc:
            lines.append(schema_desc)
            lines.append("")
        props_md = _render_schema_properties(schema)
        if props_md:
            lines.append("### Properties")
            lines.append("")
            lines.append(props_md)
            lines.append("")

        # Request examples
        examples = media_obj.get("examples", {})
        if examples:
            lines.append("### Request Examples")
            lines.append("")
            for ex_name, ex_obj in examples.items():
                summary = ex_obj.get("summary", ex_name)
                lines.append(f"**{summary}**")
                lines.append("")
                lines.append("```json")
                lines.append(json.dumps(ex_obj.get("value", {}), indent=2))
                lines.append("```")
                lines.append("")
    return "\n".join(lines)


def _render_responses(responses: dict) -> str:
    """Render the responses section."""
    if not responses:
        return ""
    lines = ["## Responses", ""]
    for status_code, resp_obj in sorted(responses.items()):
        desc = resp_obj.get("description", "")
        lines.append(f"### {status_code} — {desc}")
        lines.append("")

        # Response headers
        headers = resp_obj.get("headers", {})
        if headers:
            lines.append("**Headers:**")
            lines.append("")
            for hdr_name, hdr_obj in headers.items():
                hdr_desc = hdr_obj.get("description", "")
                lines.append(f"- `{hdr_name}`: {hdr_desc}")
            lines.append("")

        # Response body schema
        content = resp_obj.get("content", {})
        for media_type, media_obj in content.items():
            schema = media_obj.get("schema", {})
            schema_desc = schema.get("description", "")
            if schema_desc:
                lines.append(schema_desc)
                lines.append("")
            props_md = _render_schema_properties(schema)
            if props_md:
                lines.append("**Properties:**")
                lines.append("")
                lines.append(props_md)
                lines.append("")

            # Response examples
            examples = media_obj.get("examples", {})
            if examples:
                for ex_name, ex_obj in examples.items():
                    summary = ex_obj.get("summary", ex_name)
                    lines.append(f"**Example — {summary}:**")
                    lines.append("")
                    value = ex_obj.get("value", {})
                    value_str = json.dumps(value, indent=2)
                    if len(value_str) > 5000:
                        value_str = value_str[:5000] + "\n  ... (truncated)"
                    lines.append("```json")
                    lines.append(value_str)
                    lines.append("```")
                    lines.append("")
    return "\n".join(lines)


def generate_api_markdown(source: dict) -> str:
    """Generate full Markdown content for a YAML API endpoint entry."""
    method = normalize_text(source.get("yamlHttpReqMethod", "")).upper()
    path = normalize_text(source.get("yamlKey", ""))
    tag = normalize_text(source.get("yamlTag", ""))
    summary = normalize_text(source.get("yamlSummary", ""))
    description = normalize_text(source.get("yamlDescription", ""))

    # Parse the structured genAiContent JSON
    gen_ai_raw = source.get("genAiContent", "")
    try:
        spec = json.loads(gen_ai_raw) if gen_ai_raw else {}
    except json.JSONDecodeError:
        spec = {}

    # Prefer spec-level description if richer
    spec_desc = spec.get("description", "")
    display_desc = spec_desc if len(spec_desc) > len(description) else description

    sections: list[str] = []

    # Title
    title = summary or f"{method} {path}"
    sections.append(f"# {title}")
    sections.append("")

    # Overview metadata
    operation_id = spec.get("operationId", "N/A")
    sections.append(f"- **Tag:** {tag}")
    sections.append(f"- **Operation ID:** {operation_id}")
    sections.append(f"- **Method:** `{method}`")
    sections.append(f"- **Path:** `{path}`")
    sections.append("")

    if display_desc:
        sections.append("## Description")
        sections.append("")
        sections.append(display_desc)
        sections.append("")

    # Servers / endpoints
    servers = spec.get("servers", [])
    if servers:
        sections.append("## Endpoints")
        sections.append("")
        for srv in servers:
            srv_desc = srv.get("description", "")
            srv_url = srv.get("url", "")
            sections.append(f"- **{srv_desc}:** `{srv_url}`")
        sections.append("")

    # Authentication
    sections.append("## Authentication")
    sections.append("")
    sections.append("HTTP BASIC authentication over TLS 1.2+. Use your API public and secret key pair.")
    sections.append("")

    # Parameters
    parameters = spec.get("parameters", [])
    if parameters:
        sections.append("## Parameters")
        sections.append("")
        sections.append(_render_parameters_table(parameters))
        sections.append("")

    # Request body
    request_body = spec.get("requestBody", {})
    if request_body:
        sections.append(_render_request_body(request_body))

    # Responses
    responses = spec.get("responses", {})
    if responses:
        sections.append(_render_responses(responses))

    return "\n".join(sections).rstrip() + "\n"


# ---------------------------------------------------------------------------
# Markdown generation — documentation pages
# ---------------------------------------------------------------------------


def generate_doc_markdown(source: dict) -> str:
    """Generate Markdown for a non-API documentation page.

    The genAiContent for these entries is already in Markdown (or YAML overview
    text), so we use it directly with a consistent heading wrapper.
    Strips any leading heading from the content to avoid duplication.
    """
    title = disambiguated_doc_title(source)
    sub_page = source.get("subPageId", "")
    content = source.get("genAiContent", "").strip()

    sections: list[str] = []
    sections.append(f"# {title}")
    sections.append("")

    if sub_page:
        sections.append(f"*Page: {sub_page}*")
        sections.append("")

    if content:
        # Strip ANY leading top-level heading to avoid duplication, since
        # we always provide our own disambiguated # heading above.
        lines = content.split("\n")
        while lines and (lines[0].strip().startswith("# ") or not lines[0].strip()):
            lines.pop(0)
        content = "\n".join(lines).strip()

        # Guard against mega-files (raw OpenAPI spec dumps)
        if content.count("\n") > MAX_CONTENT_LINES:
            sections.append("> **Note:** This page contains a large reference document.")
            sections.append(f"> Content has been included in full ({content.count(chr(10))} lines).")
            sections.append("")

        sections.append(content)
        sections.append("")

    return "\n".join(sections).rstrip() + "\n"


def generate_yaml_overview_markdown(source: dict) -> str:
    """Generate a summary placeholder for YAML overview entries.

    These entries (isYaml=True with no HTTP method) typically contain the
    full OpenAPI spec as raw text.  Rather than dumping thousands of lines,
    generate a concise summary that references the individual API endpoint
    files for details.
    """
    title = normalize_text(source.get("title", "API Reference Overview"))
    content = source.get("genAiContent", "").strip()

    sections: list[str] = []
    sections.append(f"# {title} (OpenAPI Specification)")
    sections.append("")
    sections.append("*This entry contains the OpenAPI specification overview for the Elavon Payment Gateway API.*")
    sections.append("")
    sections.append("For detailed endpoint documentation, see the individual API endpoint files in this directory.")
    sections.append("")

    # Extract just the overview/description section if the content is parseable
    # as the raw OpenAPI YAML text
    if content:
        overview_lines: list[str] = []
        in_overview = False
        for line in content.split("\n")[:200]:  # Only scan first 200 lines
            stripped = line.strip()
            if stripped.startswith("# Overview") or stripped.startswith("## Overview"):
                in_overview = True
                overview_lines.append(stripped)
                continue
            if in_overview:
                if stripped.startswith("# ") or stripped.startswith("## "):
                    break
                overview_lines.append(line)

        if overview_lines:
            sections.append("## API Overview")
            sections.append("")
            sections.extend(overview_lines)
            sections.append("")

    return "\n".join(sections).rstrip() + "\n"


# ---------------------------------------------------------------------------
# Description extraction for llms.txt entries
# ---------------------------------------------------------------------------


def get_api_description(source: dict) -> str:
    """Extract a rich, actionable description for an API entry in llms.txt.

    Pulls from genAiContent's parsed description, falling back to
    yamlDescription, then yamlSummary.  Enriches with:
      - Required request body fields (for POST/PUT/PATCH)
      - Query parameter names (for GET collection endpoints)
      - Example scenario names if available
    """
    method = source.get("yamlHttpReqMethod", "").upper()
    path = source.get("yamlKey", "")
    operation_id = ""

    # Try to get description from parsed genAiContent
    gen_ai_raw = source.get("genAiContent", "")
    try:
        spec = json.loads(gen_ai_raw) if gen_ai_raw else {}
    except json.JSONDecodeError:
        spec = {}

    operation_id = spec.get("operationId", "")
    desc = spec.get("description", "").strip()

    if not desc:
        desc = normalize_text(source.get("yamlDescription", ""))

    # Check for description override first
    sentence = ""
    if operation_id and operation_id in _API_DESCRIPTION_OVERRIDES:
        sentence = _API_DESCRIPTION_OVERRIDES[operation_id]
    elif desc:
        sentence = extract_first_sentence(desc, max_len=120)
    if not sentence:
        summary = normalize_text(source.get("yamlSummary", ""))
        if summary:
            sentence = summary

    brief = f"{method} {path}"
    if sentence:
        brief += f" — {sentence}"

    # Append success status code hint
    responses = spec.get("responses", {})
    success_code = None
    for code in ("201", "200", "204"):
        if code in responses:
            success_code = code
            break
    if success_code:
        brief += f" [{success_code}]"

    # Enrich POST/PUT/PATCH with required fields or key body properties
    if method in ("POST", "PUT", "PATCH"):
        rb = spec.get("requestBody", {})
        content = rb.get("content", {})
        for _ct, media_obj in content.items():
            schema = media_obj.get("schema", {})
            required = schema.get("required", [])
            if required:
                brief += f" Requires: {', '.join(required[:5])}."
                break
            # If no explicit required, note key examples
            examples = media_obj.get("examples", {})
            if examples:
                summaries = [
                    ex.get("summary", name)
                    for name, ex in list(examples.items())[:3]
                ]
                brief += f" Examples: {'; '.join(summaries)}."
                break

    # Enrich GET collection endpoints with query parameter hints
    if method == "GET" and "{id}" not in path and "{" not in path:
        params = spec.get("parameters", [])
        query_params = [p.get("name") for p in params if p.get("in") == "query"]
        if query_params:
            brief += f" Query params: {', '.join(query_params[:5])}."

    # Append response shape hint for key endpoints
    if operation_id and operation_id in _API_RESPONSE_HINTS:
        brief += f" {_API_RESPONSE_HINTS[operation_id]}"

    if operation_id:
        brief += f" ({operation_id})"
    return brief


# Description overrides for API endpoints whose auto-generated descriptions
# are thin, tautological, or otherwise unhelpful.
_API_DESCRIPTION_OVERRIDES: dict[str, str] = {
    # operationId → override description (replaces the auto-generated sentence)
    "CreatePanTokens": "Tokenize one or more PANs (card numbers) for PCI-compliant storage; tokens are unique per merchant.",
    "RetrievePlanList": "A read-only collection of Plans associated with an Account for subscription billing.",
    "RetrievePlanLists": "Retrieve all read-only PlanList resources (one per Account) containing subscription Plans.",
    "Account": "Retrieve a single Account. A merchant may have multiple accounts, each with its own processor configuration.",
    "RetrieveMerchant": "Retrieve details of a Merchant including name, contact info, and linked accounts.",
    "RetrieveBatch": "Retrieve a single settlement batch containing its associated transactions.",
    "RetrieveManualBatch": "Retrieve a Manual Batch created for manual settlement of selected transactions.",
    "RetrieveNotification": "Retrieve details of a webhook notification event, including delivery status and payload.",
    "RetrieveHsmCard": "Retrieve an HSM (Hardware Security Module) encrypted card resource used for terminal-based transactions.",
    "CreateHsmCard": "Create an HSM-encrypted card resource for terminal/card-present transactions. Requires terminal and account entry mode.",
    # Tautological or thin auto-generated descriptions
    "CreateApplePayPayment": "Submit an Apple Pay token to create a payment.",
    "CreateGooglePayPayment": "Submit a Google Pay token to create a payment.",
    "CreatePazePayment": "Submit a Paze wallet token to create a payment.",
    "CreatePaymentMethodSession": "Create a session to capture a shopper's payment method without charging.",
    "UpdatePaymentMethodLink": "Overwrite an existing payment method link (e.g., update custom fields).",
    "CreateCardVerification": "Verify a card (zero-amount auth) without creating a transaction.",
    "CreateManualBatch": "Mark selected transactions for manual settlement outside the automatic batch cycle.",
    "CreateEmailReceiptRequest": "Send an email receipt for a completed transaction to a specified email address.",
    "CreateAppleTapToPayToken": "Generate an Apple Tap to Pay token for in-person contactless acceptance.",
}

# Response shape hints for key API endpoints — appended to the
# auto-generated description in llms.txt to help LLMs generate accurate code.
_API_RESPONSE_HINTS: dict[str, str] = {
    # operationId → short response shape hint
    "CreateTransaction": "Returns: `{ id, href, type, state, total, isAuthorized, authorizationCode, card, ... }`.",
    "RetrieveTransaction": "Returns: `{ id, href, type, state, total, isAuthorized, authorizationCode, card, order, batch, ... }`.",
    "CreatePaymentSession": "Returns: `{ id, href, paymentPageUrl, order, ... }`.",
    "RetrievePaymentSession": "Returns: `{ id, href, paymentPageUrl, order, state, transaction, ... }`.",
    "CreateShopper": "Returns: `{ id, href, fullName, emailAddress, ... }`.",
    "CreateStoredCard": "Returns: `{ id, href, last4, expirationMonth, expirationYear, cardBrand, shopper, ... }`.",
    "CreateOrder": "Returns: `{ id, href, total, customReference, ... }`.",
    "CreateSubscription": "Returns: `{ id, href, plan, storedCard, state, firstBillAt, nextBillAt, ... }`.",
    "CreatePlan": "Returns: `{ id, href, name, billingInterval, total, ... }`.",
    "CreatePaymentLink": "Returns: `{ id, href, paymentPageUrl, expiresAt, total, state, ... }`.",
    "CreateForexAdvice": "Returns: `{ id, href, foreignTotal, exchangeRate, marginPercentage, ... }`.",
    "CreateSurchargeAdvice": "Returns: `{ id, href, surchargeAmount, totalWithSurcharge, ... }`.",
}

# Hardcoded description overrides for entries whose source content is
# UI mockup text, raw YAML, or otherwise not extractable.
_DOC_DESCRIPTION_OVERRIDES: dict[str, str] = {
    "redirect-sdk": "Quickstart guide for integrating Elavon's hosted payment page via redirect, with code samples and a demo checkout flow.",
    "lightbox-sdk": "Quickstart guide for integrating Elavon's hosted payment page via lightbox modal overlay.",
    "fields-quickstart-sdk": "Quickstart guide for integrating Elavon Hosted Fields for secure, PCI-compliant payment data entry.",
    "submit-function": "The submit() function submits the hosted fields payment form to process the transaction.",
    "api-reference": "REST API reference for the Elavon Payment Gateway, covering authentication, request/response formats, versioning, and conventions.",
    "release-notes": "Latest release notes and changelog for the Elavon Payment Gateway API.",
    "faqs": "Frequently asked questions about the Elavon Payment Gateway, including setup, features, and troubleshooting.",
    "scheduled-payments": "Guide to creating and managing scheduled recurring payments using the Transactions and Subscriptions resources.",
    "manage-plans-and-subscriptions": "Manage existing plans and subscriptions — pause, resume, cancel, update amount, and change billing dates.",
    "cof-transactions": "Process card-on-file (COF) transactions using stored card tokens for returning customers — includes merchant-initiated and shopper-initiated flows.",
    "payment-method-capture": "Capture a shopper's payment method (card details) without processing a transaction, for later use in card-on-file or subscription flows.",
    "expand-query-parameter": "Use the expand query parameter to inline nested resource fields in API responses, reducing the need for follow-up requests.",
    "webhook-notifications": "Configure push notifications (webhooks) for transaction, payment session, and payment link events with automatic retry on failure.",
    "stored-shoppers-and-cards": "Save a customer (Shopper) and their card details (StoredCard) for repeat purchases, subscriptions, and card-on-file flows.",
    "hosted-cards": "A hosted card is a single-use, PCI-compliant card token returned by a successful checkout using a payment session.",
    "payment-links": "Generate shareable payment links with expiration dates that let customers pay online without a custom checkout page.",
    "wallets": "Enable digital wallets (Apple Pay, Google Pay) on the hosted payment page via the Payments Settings page of the EPG merchant portal.",
    "3dsecure": "Secure direct API transactions with 3-D Secure authentication and Elavon's fraud services to reduce chargebacks.",
    # Tightened descriptions for entries that were verbose
    "apple-pay": "Integrate Apple Pay for web payments; HPP redirect requires no extra work, direct API requires Apple developer registration.",
    "google-pay": "Integrate Google Pay for web payments using the EPG direct API or hosted payment page.",
    "overview": "Elavon Payment Gateway (EPG) overview — capabilities, integration methods, and supported payment types.",
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
    "testing": "Sandbox test card numbers, amounts, and scenarios for simulating approvals, declines, and errors.",
}


def get_doc_description(source: dict) -> str:
    """Extract a concise description for a doc entry in llms.txt.

    Uses hardcoded overrides for entries with unusable source content,
    then falls back to extracting the first meaningful sentence from
    genAiContent.
    """
    sub_page = source.get("subPageId", "")
    if sub_page in _DOC_DESCRIPTION_OVERRIDES:
        return _DOC_DESCRIPTION_OVERRIDES[sub_page]
    content = source.get("genAiContent", "")
    sentence = extract_first_sentence(content)
    if sentence:
        return sentence
    # Fallback: use normalized title
    return normalize_text(source.get("title", ""))


# ---------------------------------------------------------------------------
# llms.txt generation
# ---------------------------------------------------------------------------


def generate_llms_txt(
    entries: list[tuple[str, str, dict]],
    source_hash: str,
    generation_ts: str,
    *,
    include_inline_examples: bool = False,
) -> str:
    """Produce the llms.txt index referencing all generated Markdown files.

    Format follows the llms.txt proposal (https://llmstxt.org/) with:
      - Title + blockquote summary
      - Quick Reference with inline auth example
      - Topic-grouped ## Documentation section
      - CRUD-ordered, tag-grouped ## API Reference section
      - ## Optional section for supplementary material

    When include_inline_examples is True, Request Body Examples are included
    in the Quick Reference section. The default (False) keeps the index lean.
    """
    lines: list[str] = []

    # --- Title + blockquote ---
    lines.append(f"# {PRODUCT_DISPLAY_NAME}")
    lines.append("")
    lines.append("> API documentation and integration guides for Elavon Payment Gateway (EPG),")
    lines.append("> a payment processing solution for eCommerce and card-not-present (CNP) payments.")
    lines.append("> EPG supports direct REST API integration, hosted payment pages (redirect, lightbox, and")
    lines.append("> hosted fields), digital wallets (Apple Pay, Google Pay, Paze), recurring billing via")
    lines.append("> subscriptions, card-on-file transactions, surcharging, and dynamic currency conversion.")
    lines.append("")

    # --- Metadata ---
    total_api = sum(1 for k, _, _ in entries if k == "api")
    total_doc = sum(1 for k, _, _ in entries if k in ("doc", "yaml-overview"))
    lines.append("## Metadata")
    lines.append("")
    lines.append(f"- **Generated:** {generation_ts}")
    lines.append(f"- **Source:** {INPUT_FILE}")
    lines.append(f"- **Source SHA-256:** `{source_hash}`")
    lines.append(f"- **Format version:** 2.0")
    lines.append(f"- **Total entries:** {len(entries)} ({total_doc} docs, {total_api} API endpoints)")
    lines.append("")

    # --- Quick Reference with inline auth example ---
    lines.append("## Quick Reference")
    lines.append("")
    lines.append("- **Sandbox Base URL:** `https://uat.api.converge.eu.elavonaws.com`")
    lines.append("- **Production Base URL:** `https://api.eu.convergepay.com`")
    lines.append("- **Authentication:** HTTP BASIC over TLS 1.2+ (public key as username, secret key as password)")
    lines.append("- **Content-Type:** `application/json;charset=UTF-8`")
    lines.append("- **API Versioning:** Via `Accept-Version` request header (current version: `1`)")
    lines.append("- **Pagination:** Cursor-based via `pageToken`/`nextPageToken` query params; default limit `10`, max `200`")
    lines.append("- **Error format:** `{ \"status\": <http_code>, \"failures\": [{ \"code\": \"...\", \"description\": \"...\", \"field\": \"...\" }] }` — see [Error Codes](apis/error-codes.md)")
    lines.append("- **Rate limiting:** Enforced per API key; exceeding limits returns `429 Too Many Requests`. Specific thresholds are not published — implement exponential backoff with jitter on 429 responses.")
    lines.append("- **Conflict / Idempotency:** Duplicate or in-flight requests return `409 Conflict`")
    lines.append("")
    lines.append("### HTTP Status Codes")
    lines.append("")
    lines.append("| Code | Meaning | Typical Operation |")
    lines.append("|------|---------|-------------------|")
    lines.append("| `200` | OK | GET, POST update |")
    lines.append("| `201` | Created | POST create |")
    lines.append("| `204` | No Content | DELETE |")
    lines.append("| `400` | Bad Request | Validation failure |")
    lines.append("| `401` | Unauthorized | Invalid API key |")
    lines.append("| `403` | Forbidden | Public key used for non-hosted-card operation |")
    lines.append("| `404` | Not Found | Resource does not exist |")
    lines.append("| `409` | Conflict | Duplicate / in-flight request |")
    lines.append("| `429` | Too Many Requests | Rate limit exceeded |")
    lines.append("")
    lines.append("### Authentication Example")
    lines.append("")
    lines.append("```bash")
    lines.append("curl -X GET https://uat.api.converge.eu.elavonaws.com/merchants \\")
    lines.append("  -u \"<public_key>:<secret_key>\" \\")
    lines.append("  -H \"Accept: application/json\" \\")
    lines.append("  -H \"Accept-Version: 1\"")
    lines.append("```")
    lines.append("")

    # --- Data Model (resource relationships) ---
    lines.append("### Data Model")
    lines.append("")
    lines.append("```")
    lines.append("Merchant ──┬── Account ──┬── ProcessorAccount")
    lines.append("           │             ├── PlanList ── Plan ── Subscription")
    lines.append("           │             └── Terminal")
    lines.append("           │")
    lines.append("           └── Shopper ──┬── StoredCard ── Subscription")
    lines.append("                         └── StoredAchPayment")
    lines.append("")
    lines.append("Order ── PaymentSession ── Transaction ── Batch")
    lines.append("                                       └── TotalAdjustment")
    lines.append("")
    lines.append("PaymentLink ── PaymentLinkEvent")
    lines.append("PaymentMethodLink ── PaymentMethodSession")
    lines.append("```")
    lines.append("")
    lines.append("Key relationships: A **Merchant** has one or more **Accounts**, each with **ProcessorAccount** configs. ")
    lines.append("A **Shopper** holds **StoredCards** used for **Subscriptions** (tied to **Plans**). ")
    lines.append("An **Order** feeds into a **PaymentSession** which produces a **Transaction** settled in a **Batch**.")
    lines.append("")

    # --- Key Enum Values ---
    lines.append("### Key Enum Values")
    lines.append("")
    lines.append("| Field | Values |")
    lines.append("|-------|--------|")
    lines.append("| Transaction `type` | `sale`, `refund`, `void` |")
    lines.append("| Transaction `state` | `authorized`, `captured`, `settled`, `voided`, `declined`, `expired`, `settlementDelayed`, `rejected`, `heldForReview`, `authorizationPending`, `unknown` |")
    lines.append("| `shopperInteraction` | `ecommerce`, `mailOrder`, `telephoneOrder`, `merchantInitiated`, `inPerson` |")
    lines.append("| Subscription `state` | `active`, `completed`, `cancelled`, `unpaid`, `pastDue`, `unknown` |")
    lines.append("| Billing interval `timeUnit` | `day`, `week`, `month`, `year` |")
    lines.append("| `credentialOnFileType` | `none`, `recurring`, `subscription`, `unscheduled` |")
    lines.append("| Batch `state` | `submitted`, `settled`, `rejected`, `failed`, `unknown` |")
    lines.append("| Card `fundingSource` | `charge`, `credit`, `debit`, `deferredDebit`, `prepaid`, `unknown` |")
    lines.append("")

# --- Minimal Request Body Skeletons (only in full mode) ---
    if include_inline_examples:
        lines.append("### Request Body Examples")
        lines.append("")
        lines.append("**Sale transaction (direct API):**")
        lines.append("")
        lines.append("```json")
        lines.append("POST /transactions")
        lines.append('{')                                                    
        lines.append('  "total": { "amount": "45.23", "currencyCode": "EUR" },')
        lines.append('  "card": {')
        lines.append('    "holderName": "John Smith",')
        lines.append('    "number": "4111111111111111",')
        lines.append('    "expirationMonth": "12",')
        lines.append('    "expirationYear": "2027"')
        lines.append('  },')
        lines.append('  "shopperInteraction": "ecommerce"')
        lines.append('}')
        lines.append("```")
        lines.append("")
        lines.append("**Refund transaction:**")
        lines.append("")
        lines.append("```json")
        lines.append("POST /transactions")
        lines.append('{')                                                    
        lines.append('  "type": "refund",')
        lines.append('  "parentTransaction": "https://api.eu.convergepay.com/transactions/{id}"')
        lines.append('}')
        lines.append("```")
        lines.append("")
        lines.append("**Payment session (hosted redirect):**")
        lines.append("")
        lines.append("```json")
        lines.append("POST /payment-sessions")
        lines.append('{')                                                    
        lines.append('  "order": "{order_href}",')
        lines.append('  "returnUrl": "https://merchant.com/return",')
        lines.append('  "cancelUrl": "https://merchant.com/cancel",')
        lines.append('  "doCreateTransaction": "true"')
        lines.append('}')
        lines.append("```")
        lines.append("")
        lines.append("**Create a plan:**")
        lines.append("")
        lines.append("```json")
        lines.append("POST /plans")
        lines.append('{')                                                    
        lines.append('  "name": "Monthly Premium",')
        lines.append('  "billingInterval": { "timeUnit": "month", "count": 1 },')
        lines.append('  "total": { "amount": "29.99", "currencyCode": "USD" }')
        lines.append('}')
        lines.append("```")
        lines.append("")

    # --- Common Workflows (quick-reference patterns) ---
    lines.append("### Common Workflows")
    lines.append("")
    lines.append("1. **Simple sale:** `POST /payment-sessions` → redirect/lightbox/hosted fields → `GET /transactions/{id}`")
    lines.append("2. **Direct API sale:** `POST /transactions` with card or hostedCard token")
    lines.append("3. **Save card for later:** `POST /shoppers` → `POST /stored-cards` with shopper href")
    lines.append("4. **Recurring billing:** `POST /plans` → `POST /subscriptions` with storedCard")
    lines.append("5. **Refund:** `POST /transactions` with `type: \"refund\"` and original transaction href")
    lines.append("6. **Apple/Google Pay:** `POST /apple-pay-payments` or `POST /google-pay-payments`")
    lines.append("")
    # --- Webhook Event Types ---
    lines.append("### Webhook Event Types")
    lines.append("")
    lines.append("| Resource | Events |")
    lines.append("|----------|--------|")
    lines.append("| Transaction | `saleAuthorized`, `saleDeclined`, `saleHeldForReview`, `saleCaptured`, `saleSettled`, `voidAuthorized`, `voidDeclined`, `refundAuthorized`, `refundDeclined`, `refundCaptured`, `refundSettled` |")
    lines.append("| Payment Session | `expired`, `reset`, `saleDeclined`, `saleAuthorized`, `saleAuthorizationPending` |")
    lines.append("| Payment Link | `expired`, `saleDeclined`, `saleAuthorized`, `saleAuthorizationPending` |")
    lines.append("")
    lines.append("Webhook retry schedule: 30 s → 5 min → 1 h → 24 h (4 attempts). See [Webhook Notifications](apis/webhook-notifications.md).")
    lines.append("")
    # --- JS Library CDN URLs ---
    lines.append("### JS Library CDN URLs")
    lines.append("")
    lines.append("| Library | Sandbox | Production |")
    lines.append("|---------|---------|------------|")
    lines.append("| Lightbox | `https://uat.hpp.converge.eu.elavonaws.com/client/index.js` | `https://hpp.na.elavonpayments.com/client/index.js` |")
    lines.append("| Hosted Fields | `https://uat.hpp.converge.eu.elavonaws.com/hosted-fields-client/index.js` | `https://hpp.na.elavonpayments.com/hosted-fields-client/index.js` |")
    lines.append("")

    # --- Separate entry types ---
    api_entries: list[tuple[str, str, dict]] = []
    doc_entries: list[tuple[str, str, dict]] = []
    yaml_overview_entries: list[tuple[str, str, dict]] = []
    for kind, slug, source in entries:
        if kind == "api":
            api_entries.append((kind, slug, source))
        elif kind == "yaml-overview":
            yaml_overview_entries.append((kind, slug, source))
        else:
            doc_entries.append((kind, slug, source))

    # --- Documentation section (topic-grouped) ---
    if doc_entries or yaml_overview_entries:
        lines.append("## Documentation")
        lines.append("")

        # Build a lookup from subPageId → (slug, source)
        doc_lookup: dict[str, tuple[str, dict]] = {}
        for _kind, slug, source in doc_entries:
            sub_page = source.get("subPageId", slug)
            doc_lookup[sub_page] = (slug, source)

        placed_sub_pages: set[str] = set()

        for group_name, _group_slug, sub_page_ids in DOC_TOPIC_ORDER:
            group_items = []
            for sp_id in sub_page_ids:
                if sp_id in doc_lookup:
                    group_items.append((sp_id, doc_lookup[sp_id]))
                    placed_sub_pages.add(sp_id)

            if group_items:
                lines.append(f"### {group_name}")
                lines.append("")
                for sp_id, (slug, source) in group_items:
                    title = disambiguated_doc_title(source)
                    desc = get_doc_description(source)
                    rel_path = f"apis/{slug}.md"
                    lines.append(f"- [{title}]({rel_path}): {desc}")
                lines.append("")

        # Any doc entries not covered by the topic groups (excluding Optional ones)
        optional_sub_pages: set[str] = set()
        for _, _, sub_page_ids in OPTIONAL_TOPIC_ORDER:
            optional_sub_pages.update(sub_page_ids)

        ungrouped = [
            (slug, source) for _k, slug, source in doc_entries
            if source.get("subPageId", slug) not in placed_sub_pages
            and source.get("subPageId", slug) not in optional_sub_pages
        ]
        if ungrouped:
            lines.append("### Other Documentation")
            lines.append("")
            for slug, source in ungrouped:
                title = disambiguated_doc_title(source)
                desc = get_doc_description(source)
                rel_path = f"apis/{slug}.md"
                lines.append(f"- [{title}]({rel_path}): {desc}")
            lines.append("")

        # YAML overview entries (OpenAPI spec summaries)
        if yaml_overview_entries:
            lines.append("### OpenAPI Specification")
            lines.append("")
            for _kind, slug, source in yaml_overview_entries:
                title = normalize_text(source.get("title", "API Reference"))
                rel_path = f"apis/{slug}.md"
                lines.append(f"- [{title} (OpenAPI Specification)]({rel_path}): Full OpenAPI specification overview")
            lines.append("")

    # --- API Reference section (tag-grouped, CRUD-ordered) ---
    if api_entries:
        lines.append("## API Reference")
        lines.append("")

        # Group by yamlTag
        tag_groups: dict[str, list[tuple[str, dict]]] = {}
        for _kind, slug, source in api_entries:
            tag = normalize_text(source.get("yamlTag", "Other"))
            tag_groups.setdefault(tag, []).append((slug, source))

        for tag in sorted(tag_groups.keys()):
            lines.append(f"### {tag}")
            lines.append("")
            # Sort by CRUD semantics within each tag group
            sorted_items = sorted(
                tag_groups[tag],
                key=lambda item: _api_sort_key(item[0], item[1]),
            )
            for slug, source in sorted_items:
                summary = normalize_text(source.get("yamlSummary", ""))
                display = summary or f"{source.get('yamlHttpReqMethod', '').upper()} {source.get('yamlKey', '')}"
                desc = get_api_description(source)
                rel_path = f"apis/{slug}.md"
                lines.append(f"- [{display}]({rel_path}): {desc}")
            lines.append("")

    # --- Optional section (supplementary material) ---
    optional_items_exist = False
    for group_name, _group_slug, sub_page_ids in OPTIONAL_TOPIC_ORDER:
        group_items = []
        for sp_id in sub_page_ids:
            if sp_id in doc_lookup:
                group_items.append((sp_id, doc_lookup[sp_id]))
                placed_sub_pages.add(sp_id)
        if group_items:
            if not optional_items_exist:
                lines.append("## Optional")
                lines.append("")
                optional_items_exist = True
            for sp_id, (slug, source) in group_items:
                title = disambiguated_doc_title(source)
                desc = get_doc_description(source)
                rel_path = f"apis/{slug}.md"
                lines.append(f"- [{title}]({rel_path}): {desc}")
    if optional_items_exist:
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def run() -> None:
    """Main entry point — parse, generate, write."""
    products = load_input(INPUT_FILE)
    source_hash = file_sha256(INPUT_FILE)
    generation_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Build a classified, slugged list of entries
    raw_entries: list[tuple[str, str, dict]] = []
    for product in products:
        source = product.get("_source", {})
        if not source:
            log.warning("Skipping entry with empty _source: %s", product.get("_id"))
            continue

        kind = classify_entry(source)
        if kind == "api":
            slug = make_api_slug(source)
        else:
            slug = make_doc_slug(source)
        raw_entries.append((kind, slug, source))

    # Deterministic sort: docs first (alphabetical), then yaml-overview, then APIs
    kind_order = {"doc": 0, "yaml-overview": 1, "api": 2}
    raw_entries.sort(key=lambda e: (kind_order.get(e[0], 9), e[1]))

    # Deduplicate slugs
    entries = deduplicate_slugs(raw_entries)

    # Ensure output directories exist (idempotent)
    APIS_DIR.mkdir(parents=True, exist_ok=True)

    # Generate individual Markdown files
    log.info("Generating %d Markdown files ...", len(entries))
    for kind, slug, source in entries:
        if kind == "api":
            md_content = generate_api_markdown(source)
        elif kind == "yaml-overview":
            md_content = generate_yaml_overview_markdown(source)
        else:
            md_content = generate_doc_markdown(source)

        md_path = APIS_DIR / f"{slug}.md"
        md_path.write_text(md_content, encoding="utf-8")

    # Generate llms.txt
    log.info("Generating llms.txt ...")
    llms_content = generate_llms_txt(entries, source_hash, generation_ts)
    LLMS_FILE.write_text(llms_content, encoding="utf-8")

    log.info("Done. Output written to %s/", OUTPUT_DIR)
    log.info("  llms.txt:      %d entries indexed", len(entries))
    log.info("  apis/:         %d Markdown files", len(entries))


if __name__ == "__main__":
    run()
