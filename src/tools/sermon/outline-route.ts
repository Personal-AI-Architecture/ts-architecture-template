import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type GatewayRouteRequest, type GatewayRouteResponse } from "../../gateway/routes";

import { type EditTracker } from "./edit-tracker";
import { OUTLINE_SECTIONS, readOutline, replaceOutlineSection } from "./outline";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ALLOWED_SECTIONS = new Set<string>(OUTLINE_SECTIONS);

export interface CreateOutlineRouteHandlerOptions {
  sermon_root: string;
  edit_tracker?: EditTracker;
}

export type OutlineRouteHandler = (
  request: GatewayRouteRequest
) => Promise<GatewayRouteResponse | null>;

function jsonError(status: number, code: string, message: string): GatewayRouteResponse {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: { error: { code, message } }
  };
}

export function isOutlineRoutePath(value: string | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return value === "/outline" || value === "/outline/" || value.startsWith("/outline/");
}

interface SegmentParse {
  slug: string | null;
  section: string | null;
  extraSegments: boolean;
}

function parseOutlinePath(routePath: string): SegmentParse {
  if (routePath === "/outline" || routePath === "/outline/") {
    return { slug: null, section: null, extraSegments: false };
  }
  const remainder = routePath.slice("/outline/".length);
  if (remainder.length === 0) {
    return { slug: null, section: null, extraSegments: false };
  }
  const segments = remainder.split("/").filter((s) => s.length > 0);
  if (segments.length === 1) {
    return { slug: segments[0], section: null, extraSegments: false };
  }
  if (segments.length === 2) {
    return { slug: segments[0], section: segments[1], extraSegments: false };
  }
  return { slug: segments[0], section: segments[1], extraSegments: true };
}

function bodyAsString(body: unknown): { ok: true; value: string } | { ok: false } {
  if (typeof body === "string") {
    return { ok: true, value: body };
  }
  return { ok: false };
}

async function sermonFolderExists(sermonDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(sermonDir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export function createOutlineRouteHandler(
  options: CreateOutlineRouteHandlerOptions
): OutlineRouteHandler {
  if (!options?.sermon_root || options.sermon_root.trim().length === 0) {
    throw new Error("createOutlineRouteHandler requires sermon_root.");
  }
  const sermonRoot = path.resolve(options.sermon_root);
  const editTracker = options.edit_tracker;

  return async function handle(request): Promise<GatewayRouteResponse | null> {
    const method = (typeof request?.method === "string" ? request.method : "").toUpperCase();
    const routePath = typeof request?.path === "string" ? request.path : "";

    if (!isOutlineRoutePath(routePath)) {
      return null;
    }
    if (method !== "GET" && method !== "PUT") {
      return null;
    }

    const { slug, section, extraSegments } = parseOutlinePath(routePath);

    if (method === "GET") {
      // Phase 2 surface: GET /outline/<slug>; with extra segments → 400.
      if (extraSegments || section !== null) {
        return jsonError(
          400,
          "invalid_request",
          "Outline GET path must be /outline/<slug> with no extra segments."
        );
      }
      if (slug === null) {
        return jsonError(400, "invalid_request", "Missing sermon slug in /outline/<slug>.");
      }
      if (!SLUG_PATTERN.test(slug)) {
        return jsonError(
          400,
          "invalid_slug",
          "Sermon slug must match /^[a-z0-9][a-z0-9-]*$/ (lowercase ASCII, digits, hyphens)."
        );
      }
      const sermonDir = path.join(sermonRoot, slug);
      if (!(await sermonFolderExists(sermonDir))) {
        return jsonError(404, "sermon_not_found", `Sermon '${slug}' not found.`);
      }
      const content = await readOutline(sermonDir);
      return {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
        body: content
      };
    }

    // PUT /outline/<slug>/<section>
    if (extraSegments) {
      return jsonError(
        400,
        "invalid_request",
        "Outline PUT path must be /outline/<slug>/<section> with no extra segments."
      );
    }
    if (slug === null) {
      return jsonError(400, "invalid_request", "Missing sermon slug in /outline/<slug>/<section>.");
    }
    if (!SLUG_PATTERN.test(slug)) {
      return jsonError(
        400,
        "invalid_slug",
        "Sermon slug must match /^[a-z0-9][a-z0-9-]*$/ (lowercase ASCII, digits, hyphens)."
      );
    }
    if (section === null) {
      return jsonError(
        400,
        "invalid_request",
        "Missing section in /outline/<slug>/<section>."
      );
    }
    if (!ALLOWED_SECTIONS.has(section)) {
      return jsonError(
        400,
        "unknown_section",
        `Unknown section '${section}'. Allowed: ${OUTLINE_SECTIONS.join(", ")}.`
      );
    }

    const parsedBody = bodyAsString(request.body);
    if (!parsedBody.ok) {
      return jsonError(400, "invalid_request", "PUT body must be a UTF-8 string.");
    }

    const sermonDir = path.join(sermonRoot, slug);
    if (!(await sermonFolderExists(sermonDir))) {
      return jsonError(404, "sermon_not_found", `Sermon '${slug}' not found.`);
    }

    await replaceOutlineSection(sermonDir, section, parsedBody.value);
    if (editTracker) {
      editTracker.recordUserEdit(slug, section);
    }

    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { ok: true, sermon: slug, section }
    };
  };
}
