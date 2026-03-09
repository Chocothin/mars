/**
 * Component Map Schema
 *
 * Maps IR component definitions to React implementation details.
 * Produced after normalisation; consumed by the code generator to
 * emit the correct imports, file paths, and prop interfaces.
 *
 * JSON files conforming to this schema use:
 *   $schema: "component_map"
 *   version: "1.0.0"
 */

import type { IRNode, PropSchemaEntry } from "./normalized_ir";

// ---------------------------------------------------------------------------
// Schema envelope
// ---------------------------------------------------------------------------

/** Top-level component map — one per project. */
export interface ComponentMap {
  /** Schema identifier for JSON validation. */
  readonly $schema: "component_map";
  /** Schema version (semver). */
  readonly version: "1.0.0";
  /**
   * Shared components used across multiple pages.
   * Keyed by ComponentDef.id.
   */
  shared: Record<string, ComponentMapping>;
  /**
   * Page-scoped components (used on a single page only).
   * Outer key = PageMetadata.pageId, inner key = ComponentDef.id.
   */
  perPage: Record<string, Record<string, ComponentMapping>>;
}

// ---------------------------------------------------------------------------
// Component Mapping
// ---------------------------------------------------------------------------

/**
 * Maps a single IR component to its React implementation.
 * Bridges the gap between the design IR and the generated codebase.
 */
export interface ComponentMapping {
  /** ComponentDef.id this mapping refers to. */
  irComponentId: string;
  /** PascalCase React component name (e.g. "MetricCard"). */
  reactName: string;
  /**
   * File path where this component will be generated,
   * relative to the project's src/ directory
   * (e.g. "components/dashboard/MetricCard.tsx").
   */
  filePath: string;
  /** TypeScript interface name for the component's props (e.g. "MetricCardProps"). */
  propsInterface: string;
  /**
   * shadcn/ui component dependencies this component imports.
   * Used to ensure `npx shadcn add <dep>` is run before generation.
   * (e.g. ["card", "badge", "button"]).
   */
  shadcnDependencies: string[];
  /**
   * Lucide icon names used inside this component.
   * (e.g. ["ArrowUpRight", "TrendingUp"]).
   */
  lucideIcons: string[];
  /**
   * Page IDs where this component is used.
   * Shared components appear on 2+ pages; page-scoped on exactly 1.
   */
  usedOnPages: string[];
  /** Current generation status of this component. */
  status: ComponentStatus;
}

/**
 * Tracks the lifecycle of a component through the pipeline.
 *
 * - detected   — found during normalisation, not yet generated
 * - mapped     — mapping complete, ready for code generation
 * - generated  — React code has been emitted
 * - validated  — generated code passes type-checking and lint
 */
export type ComponentStatus = "detected" | "mapped" | "generated" | "validated";

// ---------------------------------------------------------------------------
// Component Index (convenience aggregations)
// ---------------------------------------------------------------------------

/**
 * Summary statistics for the component map.
 * Useful for pipeline dashboards and progress tracking.
 */
export interface ComponentMapSummary {
  /** Total unique components across all pages. */
  totalComponents: number;
  /** Components shared across 2+ pages. */
  sharedCount: number;
  /** Components scoped to a single page. */
  pageSpecificCount: number;
  /** Count by status. */
  byStatus: Record<ComponentStatus, number>;
  /** All shadcn/ui dependencies needed (deduplicated). */
  allShadcnDependencies: string[];
  /** All Lucide icons needed (deduplicated). */
  allLucideIcons: string[];
}

/**
 * Describes a component that needs to be resolved —
 * i.e. the generator hasn't yet produced code for it.
 */
export interface UnresolvedComponent {
  /** ComponentDef.id. */
  irComponentId: string;
  /** PascalCase React component name. */
  reactName: string;
  /** Props schema from the IR. */
  propsSchema: Record<string, PropSchemaEntry>;
  /** The canonical IR subtree for this component. */
  template: IRNode;
  /** Pages that are blocked until this component is generated. */
  blockedPages: string[];
}
