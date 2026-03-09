/**
 * Normalized Intermediate Representation (IR) Schema
 *
 * This is the core data format for the MARS design-to-code pipeline.
 * One NormalizedIR document is produced per Penpot page by the normalizer,
 * then consumed by the code generator to emit React + Tailwind components.
 *
 * JSON files conforming to this schema use:
 *   $schema: "normalized_ir"
 *   version: "1.0.0"
 */

// ---------------------------------------------------------------------------
// Schema envelope
// ---------------------------------------------------------------------------

/** Top-level document — one per Penpot page. */
export interface NormalizedIR {
  /** Schema identifier for JSON validation. */
  readonly $schema: "normalized_ir";
  /** Schema version (semver). */
  readonly version: "1.0.0";
  /** Metadata about the source design page. */
  metadata: PageMetadata;
  /** App-shell zone boundaries (header, sidebar, main, rightPanel). */
  appShell: AppShellSpec;
  /** Root node of the IR tree — always type "page". */
  root: IRNode;
  /** Reusable component definitions extracted from this page. */
  components: ComponentDef[];
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** Describes the source design page and extraction context. */
export interface PageMetadata {
  /** Penpot page UUID. */
  pageId: string;
  /** Human-readable page name from Penpot. */
  pageName: string;
  /** React Router path this page maps to (e.g. "/dashboard"). */
  routePath: string;
  /** Original Penpot file name or export path. */
  sourceFile: string;
  /** Canvas dimensions of the design frame. */
  canvas: CanvasSpec;
  /** Total number of shapes extracted from the page. */
  shapeCount: number;
  /** Number of reusable components detected. */
  componentCount: number;
  /** ISO-8601 timestamp when this IR was generated. */
  generatedAt: string;
}

/** Canvas / artboard dimensions. */
export interface CanvasSpec {
  /** Canvas width in pixels. */
  width: number;
  /** Canvas height in pixels. */
  height: number;
}

// ---------------------------------------------------------------------------
// App Shell
// ---------------------------------------------------------------------------

/**
 * Defines the four-zone app shell layout.
 * Common MARS layout: Header (52px top) + Sidebar (220px left)
 *   + Main Content (flex) + Optional Right Panel.
 */
export interface AppShellSpec {
  /** Top header zone bounds. */
  header: ZoneBounds | null;
  /** Left sidebar zone bounds. */
  sidebar: ZoneBounds | null;
  /** Main content area bounds (fills remaining space). */
  main: ZoneBounds;
  /** Optional right panel zone bounds. */
  rightPanel: ZoneBounds | null;
}

/** Rectangular bounds for an app-shell zone. */
export interface ZoneBounds {
  /** Distance from the left edge of the canvas (px). */
  x: number;
  /** Distance from the top edge of the canvas (px). */
  y: number;
  /** Zone width (px). */
  width: number;
  /** Zone height (px). */
  height: number;
}

// ---------------------------------------------------------------------------
// IR Node — core tree node
// ---------------------------------------------------------------------------

/**
 * Every element in the IR is an IRNode.
 * The tree mirrors the visual hierarchy of the design with
 * semantic enrichment (component refs, layout specs, etc.).
 */
export interface IRNode {
  /** Unique node identifier (deterministic, derived from source shape IDs). */
  id: string;
  /** Human-readable name (from Penpot layer name or generated). */
  name: string;
  /** Semantic node type. */
  type: NodeType;
  /** Penpot shape UUIDs this node was derived from (provenance). */
  sourceShapeIds: string[];
  /** Layout specification for this node. */
  layout: LayoutSpec;
  /** Visual style specification. */
  style: StyleSpec;
  /** Ordered child nodes (empty array for leaf nodes). */
  children: IRNode[];
  /** Reference to a ComponentDef.id if this node is a component instance. */
  componentRef?: string;
  /** Props passed to the component when componentRef is set. */
  props?: Record<string, PropValue>;
  /** Text / input / icon content specification. */
  content?: ContentSpec;
}

/**
 * Semantic node types.
 * These drive code generation decisions (which React element or component to emit).
 */
export type NodeType =
  | "page"
  | "zone"
  | "component"
  | "group"
  | "text"
  | "icon"
  | "image"
  | "shape"
  | "input"
  | "button"
  | "badge"
  | "divider"
  | "table"
  | "table-header"
  | "table-row"
  | "table-cell";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Describes how a node lays out itself and its children. */
export interface LayoutSpec {
  /** CSS display model. */
  display: "flex" | "grid" | "absolute" | "contents";
  /** Flex direction (only meaningful when display is "flex"). */
  direction?: "row" | "column";
  /** Gap between children (px). */
  gap?: number;
  /** Cross-axis alignment. */
  alignItems?: "start" | "center" | "end" | "stretch" | "baseline";
  /** Main-axis distribution. */
  justifyContent?: "start" | "center" | "end" | "between" | "around" | "evenly";
  /** Width sizing. */
  width?: SizeSpec;
  /** Height sizing. */
  height?: SizeSpec;
  /** Padding on each edge. */
  padding?: Edges;
  /** Number of grid columns (only meaningful when display is "grid"). */
  gridCols?: number;
  /** Absolute position coordinates (only meaningful when display is "absolute"). */
  absolutePosition?: AbsolutePosition;
  /** Overflow behaviour. */
  overflow?: "visible" | "hidden" | "scroll" | "auto";
}

/**
 * Sizing specification.
 * Maps to Tailwind utilities:
 *   fixed  → w-[{px}px]
 *   fill   → w-full / flex-1
 *   hug    → w-fit
 *   percent → w-[{value}%]
 */
export type SizeSpec =
  | { mode: "fixed"; px: number }
  | { mode: "fill" }
  | { mode: "hug" }
  | { mode: "percent"; value: number };

/** Edge values (px) for padding, margin, border-width, etc. */
export interface Edges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Absolute positioning coordinates relative to the parent. */
export interface AbsolutePosition {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

/** Visual style properties that map to Tailwind / CSS. */
export interface StyleSpec {
  /** Background color. */
  bg?: ColorRef;
  /** Border radius (px, uniform or per-corner). */
  borderRadius?: number | [number, number, number, number];
  /** Border specification. */
  border?: BorderSpec;
  /** Opacity (0–1). */
  opacity?: number;
  /** Box shadow. */
  shadow?: ShadowSpec;
  /** Design-token references applied to this node (for traceability). */
  tokenRefs?: Record<string, string>;
}

/** Color reference — raw hex + optional design-token binding. */
export interface ColorRef {
  /** Hex color value (e.g. "#1E1E2E"). */
  hex: string;
  /** Alpha channel (0–1). Defaults to 1 when absent. */
  opacity?: number;
  /** Design-token name this color resolves from (e.g. "surface-primary"). */
  token?: string;
}

/** Border specification. */
export interface BorderSpec {
  /** Border width (px). */
  width: number;
  /** Border color. */
  color: ColorRef;
  /** Border style. */
  style: "solid" | "dashed" | "dotted" | "none";
}

/** Shadow specification. */
export interface ShadowSpec {
  /** Horizontal offset (px). */
  x: number;
  /** Vertical offset (px). */
  y: number;
  /** Blur radius (px). */
  blur: number;
  /** Spread radius (px). */
  spread: number;
  /** Shadow color. */
  color: ColorRef;
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/**
 * Content carried by leaf nodes (text, input, icon, button labels, etc.).
 * Which fields are populated depends on the parent IRNode.type.
 */
export interface ContentSpec {
  /** Static text content. */
  text?: string;
  /** Font size (px). */
  fontSize?: number;
  /** Font weight (CSS numeric: 400, 500, 600, 700 …). */
  fontWeight?: number;
  /** Font family name. */
  fontFamily?: string;
  /** Text color. */
  textColor?: ColorRef;
  /** Text alignment. */
  textAlign?: "left" | "center" | "right" | "justify";
  /** Input placeholder text (for type "input"). */
  placeholder?: string;
  /** HTML input type (for type "input"). */
  inputType?: "text" | "email" | "password" | "number" | "search" | "tel" | "url";
  /** Lucide icon name (for type "icon"). */
  iconName?: string;
  /** Icon size (px). */
  iconSize?: number;
}

// ---------------------------------------------------------------------------
// Props & Prop Values
// ---------------------------------------------------------------------------

/**
 * Typed prop value that can appear in IRNode.props.
 * Discriminated union on the `kind` field.
 */
export type PropValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "color"; value: ColorRef }
  | { kind: "icon"; value: string }
  | { kind: "slot"; children: IRNode[] }
  | { kind: "array"; items: PropValue[] };

// ---------------------------------------------------------------------------
// Component Definition
// ---------------------------------------------------------------------------

/**
 * A reusable component extracted from the design.
 * One ComponentDef is created per unique component detected in a page.
 * Instances reference it via IRNode.componentRef.
 */
export interface ComponentDef {
  /** Unique component identifier (deterministic). */
  id: string;
  /** PascalCase React component name (e.g. "MetricCard"). */
  reactName: string;
  /** Human-readable description of the component's purpose. */
  description: string;
  /** How this component was detected in the design. */
  detection: ComponentDetection;
  /** Canonical template — the IR subtree for one representative instance. */
  template: IRNode;
  /** Schema of the component's props (prop name → type descriptor). */
  propsSchema: Record<string, PropSchemaEntry>;
  /** shadcn/ui base component to extend (e.g. "Card", "Button"). */
  shadcnBase?: string;
  /** Named visual variants (e.g. "active", "disabled"). */
  variants?: Record<string, VariantSpec>;
}

/** Describes how a component was detected during normalisation. */
export interface ComponentDetection {
  /** Detection method used. */
  method: "name-pattern" | "structural-similarity" | "penpot-component" | "manual";
  /** Regex or glob that matched layer names (for "name-pattern" method). */
  namePattern?: string;
  /** Number of instances found in the page. */
  instanceCount: number;
  /** IRNode.id values of every instance of this component. */
  instanceNodeIds: string[];
}

/** Describes a single prop in a component's propsSchema. */
export interface PropSchemaEntry {
  /** Prop type. */
  type: "string" | "number" | "boolean" | "color" | "icon" | "slot" | "array";
  /** Whether the prop is required. */
  required: boolean;
  /** Default value (JSON-serialisable). */
  defaultValue?: string | number | boolean;
  /** Human-readable description. */
  description?: string;
}

/** A named visual variant of a component. */
export interface VariantSpec {
  /** Description of when this variant applies. */
  description: string;
  /** Style overrides applied for this variant. */
  styleOverrides: Partial<StyleSpec>;
  /** Prop values that trigger this variant. */
  propOverrides?: Record<string, PropValue>;
}
